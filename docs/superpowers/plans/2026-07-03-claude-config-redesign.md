# CLAUDE.md / .claude 構成再構成 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 資産（CLAUDE.md・エージェント・スキル・フック）を Git 共有化し、フックを配線し、CLAUDE.md をコード実態に同期する。

**Architecture:** コード変更なしの設定・ドキュメント作業。①`.gitignore` を緩めて既存資産をコミット ②共有 `settings.json` に permissions 統合＋PostToolUse フック配線 ③CLAUDE.md 全面書き直し ④全体検証と PR。スペック: `docs/superpowers/specs/2026-07-03-claude-config-redesign-design.md`。

**Tech Stack:** Claude Code 設定（settings.json / hooks / agents / skills）、git、npm workspaces。

## Global Constraints

- 作業ブランチは `chore/claude-config-redesign`（作成済み）。main へ直コミットしない。
- `.claude/agents/*`・`.claude/skills/*`・`.claude/hooks/post-edit-check.mjs` の **内容は 1 バイトも変更しない**（追跡化のみ）。
- `.mcp.json`・`.claude/launch.json`・`gf-pin.png`・`docs/` の既存設計書は変更しない。
- 書き直し後の CLAUDE.md は 70 行以内を目安、日本語、「コードを正とする」方針を維持。
- ファイル編集は必ず Write/Edit ツールで行う（PowerShell の `Out-File` は UTF-16 になり壊れるため使用禁止）。
- `.gitignore` は既存の日本語ファイル名の行を含むため、**全体書き換えせず該当行のみ Edit** する。

---

### Task 1: 共有資産の Git 追跡化（.gitignore 変更＋既存資産コミット）

**Files:**
- Modify: `.gitignore`（`.claude/` ブロックのみ）
- Commit（内容変更なし）: `.claude/agents/migration-safety-reviewer.md`, `.claude/agents/reconcile-invariant-reviewer.md`, `.claude/skills/add-migration/SKILL.md`, `.claude/skills/add-sync-scenario/SKILL.md`, `.claude/hooks/post-edit-check.mjs`

**Interfaces:**
- Consumes: なし
- Produces: `.claude/agents|skills|hooks` が追跡済みになる（Task 4 の検証が前提とする）

- [ ] **Step 1: `.gitignore` の `.claude/` ブロックを書き換える**

Edit ツールで次の置換を行う（この 5 行は現在ファイル末尾近くに連続して存在する）:

置換前:
```
.claude/agents/
.claude/hooks
.claude/skills
.claude/settings.local.json
.claude/worktrees/
```

置換後:
```
.claude/settings.local.json
.claude/worktrees/
.claude/scheduled_tasks.lock
```

- [ ] **Step 2: 除外解除を確認する**

Run: `git status --short .claude`
Expected: `.claude/agents/`, `.claude/hooks/`, `.claude/skills/` 配下の 5 ファイルが `??`（未追跡）として表示され、`settings.local.json` と `scheduled_tasks.lock` は表示されない。

- [ ] **Step 3: 資産を add して内容無変更を確認する**

Run:
```bash
git add .gitignore .claude/agents .claude/skills .claude/hooks
git diff --cached --stat
```
Expected: `.gitignore` ＋新規 5 ファイル（agents 2・skills 2・hooks 1）のみ。それ以外のパスが出たら add を取り消して原因を確認する。

- [ ] **Step 4: コミット**

```bash
git commit -m "chore: Claude Code 資産（agents/skills/hooks）を Git 共有化

.gitignore の除外を解除し、クロス PC で同一の Claude Code 環境になるようにする。
scheduled_tasks.lock はセッション一時ファイルのため新たに除外。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: settings 統合とフック配線

**Files:**
- Modify: `.claude/settings.json`（全置換）
- Modify: `.claude/settings.local.json`（全置換・Git 対象外）

**Interfaces:**
- Consumes: Task 1 でコミット済みの `.claude/hooks/post-edit-check.mjs`
- Produces: PostToolUse フック配線（Task 4 の検証対象）

- [ ] **Step 1: `.claude/settings.json` を次の内容に全置換する**

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(npm run:*)",
      "Bash(cargo test:*)",
      "Bash(cargo clippy:*)",
      "Bash(cargo fmt:*)",
      "Bash(git fetch:*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/post-edit-check.mjs"
          }
        ]
      }
    ]
  }
}
```

補足: 旧共有設定の `npm run typecheck:*` / `npm run test:*` は `Bash(npm run:*)` に包含されるため統合。旧ローカル設定の `npm run *` / `git fetch *`（旧スペース構文）はコロン構文で共有側へ吸収。フックのコマンドは相対パス（フック実行時の cwd はプロジェクトルート。スクリプト自身も自分の位置から projectRoot を解決するため二重に安全）。

- [ ] **Step 2: `.claude/settings.local.json` を次の内容に全置換する**

```json
{
  "permissions": {
    "allow": []
  }
}
```

（PC 固有の許可を置く場所として空で残す。Git 対象外なのでコミットしない。）

- [ ] **Step 3: JSON として妥当か検証する**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8')); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 4: フックスクリプトを手動実行して動作検証する**

Run（絶対パスで core 配下の TS を編集したことにする。sync 配下ではないので型チェックのみ走る）:
```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"C:\\path\\to\\gantt-flow\\packages\\core\\src\\ids.ts"}}' | node .claude/hooks/post-edit-check.mjs
echo "exit=$?"
```
Expected: 型チェックが数秒走った後、出力なしで `exit=0`。

- [ ] **Step 5: コミット**

```bash
git add .claude/settings.json
git commit -m "chore: settings.json に permissions を統合し post-edit フックを配線

TS 編集で該当ワークスペースの型チェック、sync 配下編集で core テストが
自動実行される（.claude/hooks/post-edit-check.mjs、両 PC 共通）。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: CLAUDE.md の書き直しとコミット

**Files:**
- Create（現状未追跡のため実質新規）: `CLAUDE.md`（全置換）

**Interfaces:**
- Consumes: なし
- Produces: 追跡済み CLAUDE.md（Task 4 の検証対象）

- [ ] **Step 1: `CLAUDE.md` を次の内容に全置換する**

````markdown
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
````

- [ ] **Step 2: 行数と記載内容を検証する**

Run: `wc -l CLAUDE.md`
Expected: 70 行以下。

Run: `grep -c "mcp-server\|fsstore\|\.gflow" CLAUDE.md`
Expected: 1 以上（新規記載 3 点が入っていること）。

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md を実態に同期して Git 追跡化

apps/mcp-server と crates/fsstore を構成に追加、desktop src の記述を現状
（約30ファイル＋src/ui/）へ更新、.gflow の乖離記述を現用単一 JSON に修正。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 全体検証と PR 作成

**Files:**
- なし（検証と PR のみ）

**Interfaces:**
- Consumes: Task 1〜3 のコミット
- Produces: レビュー可能な PR（マージはユーザ判断）

- [ ] **Step 1: ワークスペース全体のテストと型チェック**

Run: `npm test --workspaces --if-present`
Expected: core / desktop / mcp-server すべて PASS。

Run: `npm run typecheck --workspaces --if-present`
Expected: エラーなし。

- [ ] **Step 2: クリーンチェックアウト相当の確認**

Run: `git status --short`
Expected: 未追跡は `gf-pin.png` のみ（`CLAUDE.md`・`.claude/` 関連が残っていないこと）。

- [ ] **Step 3: push して PR を作成する**

```bash
git push -u origin chore/claude-config-redesign
gh pr create --title "chore: Claude Code 資産の共有化と CLAUDE.md の実態同期" --body "## 概要
- CLAUDE.md・エージェント2・スキル2・フックを Git 共有化（.gitignore 緩和）し、クロス PC で同一の Claude Code 環境にする
- 共有 settings.json に permissions を統合し、PostToolUse フック（TS編集→型チェック、sync配下→coreテスト）を配線
- CLAUDE.md をコード実態（apps/mcp-server / crates/fsstore / .gflow 現用 / src 構成）に同期

設計スペック: docs/superpowers/specs/2026-07-03-claude-config-redesign-design.md

## 動作確認
- フックスクリプト手動実行で exit 0（型チェック発火）
- npm test / typecheck 全ワークスペース green

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: PR の URL が表示される。

- [ ] **Step 4: 次セッションでのフック発火をユーザに案内する**

settings.json のフックは新しい Claude Code セッションから有効。ユーザへの完了報告に「次回セッションで TS 編集後に型チェックが自動で走ること」「もう一方の PC は `git pull` のみで同一環境になること」を明記する。
