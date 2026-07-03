# CLAUDE.md / .claude 構成のゼロベース再構成 — 設計

日付: 2026-07-03
ステータス: 承認済み（設計）

## 背景と目的

Claude Code 関連資産のうち Git 追跡されているのは `.claude/settings.json`・`.claude/launch.json`・
`.mcp.json` の 3 つだけで、`CLAUDE.md`・エージェント 2 つ・スキル 2 つ・フックスクリプトは
未追跡（`.gitignore` が `.claude/agents/` `.claude/hooks` `.claude/skills` を明示的に除外）。
クロス PC 開発の整備（`b7f12cb`）後も、Claude 環境は片方の PC に閉じている。
さらにフックスクリプト `post-edit-check.mjs` はどの settings にも配線されておらず死んでいる。
CLAUDE.md にはコードとの乖離もある（`apps/mcp-server`・`crates/fsstore` 未記載、
desktop src の「フラットな 8 ファイル」記述が実態約 28 ファイル＋サブディレクトリと不一致）。

目的（ユーザ確認済み・4 点すべて）:

1. クロス PC で同一の Claude Code 体験（共有すべき資産を Git 管理へ）
2. 作業品質向上（フックを配線し、型チェック＋sync 編集時テストを自動化）
3. 整理・スリム化（死に設定・重複の除去）
4. CLAUDE.md の内容を実態に合わせて書き直し

## 設計

### 1. 共有範囲（Git 追跡の変更）

コミットする:

- `CLAUDE.md`（書き直し版・§3）
- `.claude/settings.json`（permissions 統合＋hooks 配線・§2）
- `.claude/agents/migration-safety-reviewer.md` / `.claude/agents/reconcile-invariant-reviewer.md`（内容そのまま）
- `.claude/skills/add-migration/SKILL.md` / `.claude/skills/add-sync-scenario/SKILL.md`（内容そのまま）
- `.claude/hooks/post-edit-check.mjs`（内容そのまま）

`.gitignore` の変更:

- 削除: `.claude/agents/`・`.claude/hooks`・`.claude/skills` の 3 行
- 維持: `.claude/settings.local.json`・`.claude/worktrees/`
- 追加: `.claude/scheduled_tasks.lock`（セッション管理の一時ファイル）

未追跡の `gf-pin.png` はスコープ外（触らない）。

### 2. settings の整理

共有 `.claude/settings.json`:

- permissions: 現行共有分（`npm test` / `npm run typecheck` / `npm run test` / `cargo test` /
  `cargo clippy` / `cargo fmt`）に、現行ローカル分（`npm run *`・`git fetch *`）を吸収して統合。
- hooks: `PostToolUse`、matcher `Edit|Write`、command
  `node .claude/hooks/post-edit-check.mjs` を配線。両 PC で
  「TS 編集 → 該当ワークスペース型チェック、`packages/core/src/sync/` 配下 → core テストも実行」
  が強制有効になる（ユーザ確認済み）。

`settings.local.json`: 共有と重複する permissions を削除し、PC 固有の許可だけを置く場所として残す。

フックスクリプト本体は現行設計のまま変更しない。

### 3. CLAUDE.md の書き直し

現行の章立て（概要 → モノレポ構成 → 設計ルール → reconcile 不変条件 → 開発コマンド →
テスト方針 → docs と実装の乖離 → スタック詳細）を維持し、以下を実態に同期する:

- モノレポ構成に追加:
  - `apps/mcp-server`（`@gantt-flow/mcp`）— core を stdio で公開する MCP サーバ。
    編集は「core コマンド → `reconcileProject` → `meta.updatedAt` 更新 → アトミック保存」を
    1 単位で適用する write-through。
  - `crates/fsstore` — 共有フォルダ向けアトミック保存＋助言ロックの純 Rust 層。
    `src-tauri` は保存/ロックをここへ委譲。
- desktop src の記述を実態へ: フラット構成は維持しつつ主要ファイルを挙げ、
  `ui/`・`fonts/` サブディレクトリと約 28 ファイルという規模感に合わせる（全列挙はしない）。
- 「docs と実装の乖離」セクションは書き直し時にコードで再検証して更新する。
  特に `.gflow`: mcp-server README は現用と記述しており、`packages/core/src/persistence` と
  desktop の保存経路を確認し正しい方を採る。
- 開発コマンドに mcp-server（`npm run build -w @gantt-flow/mcp` / `npm run dev -w @gantt-flow/mcp`）を追記。
- 分量は現状同等（60〜70 行）を上限目安とし、増やさない。日本語・「コードを正とする」方針は維持。

### 4. 進め方と検証

- 作業ブランチ: `chore/claude-config-redesign`（main 直コミットしない）。PR で main へ。
- 完了検証:
  1. 実編集でフックが発火し、型チェック（と sync 編集時のテスト）が走ること。
  2. `npm test --workspaces` および `npm run typecheck --workspaces` がグリーン。
  3. もう一方の PC では `git pull` のみで同一環境になること（`settings.local.json` なしで動作）。

## スコープ外

- フックの拡張（Rust `.rs` 編集対応、lint 追加など）
- エージェント・スキルの内容改訂、新規エージェント/スキルの追加
- `.mcp.json`・`launch.json` の変更
- `gf-pin.png` の扱い
- `docs/` 本体（設計書群）の改訂
