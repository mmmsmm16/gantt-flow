# gantt-flow

業務ヒアリングの成果物を **手順一覧表（工程表）** と **スイムレーン業務フロー図（工程フロー）**
の 2 形態で作成し、**両者を同期** させるデスクトップアプリ。
工程表を編集すると、対応する工程フローが自動的に更新されるのが目玉機能。

- 機密データは社内共有フォルダにファイルとして保存（オフライン・ローカルファイル中心・クラウド非依存）。
- 工程は **大 > 中 > 小 > 詳細** の階層（4 階層は型・深さは可変）で扱い、フローはどの粒度でも閲覧でき、
  親範囲（大/中工程）を帯で可視化する。

> 技術スタックは Tauri 2 + React + TypeScript を想定。現在は **設計書 + ドメイン層（`packages/core`）** まで実装済みで、
> **起動できる GUI アプリはまだありません**（下記「現在の状態」を参照）。

## 現在の状態

| レイヤ | 状態 |
|---|---|
| 設計書（`docs/`） | ✅ 完了（仕様・決定事項・UIワイヤー） |
| `packages/core`（純粋TSドメイン: モデル・コマンド・同期`reconcile`・検証） | ✅ 第1版（Vitest 16件 green） |
| 永続化 / ストア(Undo) / UI(表・フロー) / Tauri 殻 | ⛔ 未実装 |

→ いま「動かせる」のは **`packages/core` のテスト・型チェック** です。GUI の起動はまだできません。

## はじめかた（開発セットアップ）

前提: **Node.js 22+**（`node -v` で確認）／ npm 10+。

```bash
# 1. クローン
git clone https://github.com/mmmsmm16/gantt-flow.git
cd gantt-flow

# 2. 依存をインストール（npm workspaces）
npm install

# 3. ドメイン層のテストを実行（同期エンジン等）
npm test

# 4. 型チェック
npm run typecheck
```

`packages/core` 単体で作業する場合:

```bash
cd packages/core
npm run test:watch   # 変更監視でテスト
```

### アプリの起動について

GUI（工程表ビュー / フロービュー）と Tauri デスクトップ殻は**未実装**のため、現時点で起動コマンドはありません。
実装の進め方は [docs/06-roadmap.md](docs/06-roadmap.md)（Phase 1〜）を参照。起動手順は GUI 実装後にここへ追記します。

### UI ワイヤーフレーム（参考）

`docs/wireframes/` に画面イメージ（PNG）があります。再生成する場合は Python + cairosvg + 日本語フォント(IPAGothic 等)が必要:

```bash
cd docs/wireframes && python3 build.py
```

## リポジトリ構成

```
gantt-flow/
├── docs/                 # 設計書（00〜08）＋ wireframes/
├── packages/
│   └── core/             # 純粋TSドメイン層（UI非依存・Vitest）
│       ├── src/          # model / commands / sync(reconcile) / validate
│       └── test/
├── package.json          # npm workspaces ルート
└── README.md
```

## 設計ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | 目的・対象ユーザー・ユースケース・用語定義 |
| [docs/01-architecture.md](docs/01-architecture.md) | 技術スタック・モジュール構成・全体像 |
| [docs/02-data-model.md](docs/02-data-model.md) | データモデル（階層ツリー＋3層分離） |
| [docs/03-view-spec.md](docs/03-view-spec.md) | 工程表ビュー／フロービュー仕様 |
| [docs/04-sync-spec.md](docs/04-sync-spec.md) | 同期（reconcile）仕様・アルゴリズム |
| [docs/05-persistence.md](docs/05-persistence.md) | ファイル形式・保存・共有フォルダ運用 |
| [docs/06-roadmap.md](docs/06-roadmap.md) | MVP 段階分け |
| [docs/07-open-questions.md](docs/07-open-questions.md) | 後で整合する未確定事項 |
| [docs/08-testing.md](docs/08-testing.md) | テスト戦略 |
