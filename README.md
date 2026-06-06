# gantt-flow

業務ヒアリングの成果物を **手順一覧表（工程表）** と **スイムレーン業務フロー図（工程フロー）**
の 2 形態で作成し、**両者を同期** させるデスクトップアプリ。
工程表を編集すると、対応する工程フローが自動的に更新されるのが目玉機能。

- 機密データは社内共有フォルダにファイルとして保存（オフライン・ローカルファイル中心・クラウド非依存）。
- 工程は **大 > 中 > 小 > 詳細** の階層（4 階層は型・深さは可変）で扱い、フローはどの粒度でも閲覧でき、
  親範囲（大/中工程）を帯で可視化する。

> 技術スタックは Tauri 2 + React + TypeScript を想定。現在は **設計書 + ドメイン層（`packages/core`）+ 最小Web UI（`apps/desktop`）** まで実装済み。
> **ブラウザで起動して「表を編集 → フロー自動同期」を体験できます**（Tauri デスクトップ殻はこれから）。

## 現在の状態

| レイヤ | 状態 |
|---|---|
| 設計書（`docs/`） | ✅ 完了（仕様・決定事項・UIワイヤー） |
| `packages/core`（モデル・コマンド・同期`reconcile`・永続化・履歴） | ✅ 実装（Vitest 40件 green） |
| `apps/desktop`（React 最小UI: 工程表＋フロー＋Undo/Redo） | ✅ Web版が起動可（Vitest 4件 green） |
| Tauri デスクトップ殻 / 取り込み(Excel) / 粒度ビュー切替 | ⛔ 未実装 |

## はじめかた（クローン → 起動）

前提: **Node.js 22+**（`node -v` で確認）／ npm 10+。

```bash
# 1. クローン
git clone https://github.com/mmmsmm16/gantt-flow.git
cd gantt-flow

# 2. 依存をインストール（npm workspaces）
npm install

# 3. アプリを起動（ブラウザで http://localhost:5173 が開く）
npm run dev -w @gantt-flow/desktop
```

起動したら **「＋作業を追加」** で工程を足し、表で担当・前工程・I/O・課題を編集すると、
右の **業務フロー図が自動で同期** されます。フローのノードはドラッグで動かせ、配置は編集を跨いで保持されます（戻す/やり直しも可）。

### 開発（テスト・型チェック・ビルド）

```bash
npm test            # 全ワークスペースのテスト（core 40 + desktop 4）
npm run typecheck   # 型チェック
npm run build -w @gantt-flow/desktop   # 本番ビルド
```

`packages/core` 単体で作業する場合は `cd packages/core && npm run test:watch`。

> Tauri デスクトップ殻（ローカルファイル保存・同時編集ロック等）は未実装です。進め方は [docs/06-roadmap.md](docs/06-roadmap.md) を参照。

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
│       ├── src/          # model / commands / sync(reconcile) / persistence / history / validate
│       └── test/
├── apps/
│   └── desktop/          # React 最小UI（Vite）。store は core を薄く包む
│       ├── src/          # App / TableView / FlowCanvas / store
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
