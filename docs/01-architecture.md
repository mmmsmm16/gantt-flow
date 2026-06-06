# 01. Architecture

## 1. 技術スタック

| 領域 | 採用 | 理由 |
|---|---|---|
| デスクトップシェル | **Tauri 2**（Rust） | インストーラが数 MB と小さく、Node ランタイムを同梱しないため攻撃面が小さい。機密データを扱う社内ツール向き。ネットワーク共有（UNC パス）へのネイティブアクセスとファイルダイアログが扱いやすい。 |
| UI | **React 18 + TypeScript** | コンポーネント志向。ロジックの大半を TS に集約し、Rust 側は薄く保つ。 |
| ビルド | **Vite** | 高速な開発サーバ／ビルド。 |
| 状態管理 | **Zustand** | 単純・テスト容易。コアストアをヘッドレスでテストできる。 |
| フロー描画 | **@xyflow/react (React Flow v12)** | ノード／エッジ・手動配置・カスタムノード（判断ひし形・合流・開始終了）・グループ（レーン／バンド）に最適。 |
| 表描画 | 自前のテーブル＋アウトライン（軽量ライブラリ or 自前） | 階層アウトライン（WBS 風）＋粒度フィルタという独自要件のため、汎用グリッドに縛られず自前管理する方が素直。 |
| バリデーション | **Zod** | 読込時パース＋マイグレーションの型境界。 |
| テスト | **Vitest**（単体／結合）＋ **Playwright**（薄い E2E） | 同期エンジンを純粋関数として徹底的に単体テストする。 |
| 日付処理 | **date-fns** | 工数・期間補助（将来）。 |

> Rust 側の責務は **ファイルの開く／保存ダイアログ・アトミック読み書き・自動保存・
> 「ディスク上で変更された」検知** に限定する。ドメイン・同期・描画・出力はすべて TS。
> これにより、万一 Tauri から離れる場合でも UI ロジックは可搬。

## 2. レイヤリングの原則

```
┌──────────────────────────────────────────────┐
│ apps/desktop (Tauri + React) — UI シェル        │
│   ・工程表ビュー / フロービュー                    │
│   ・open/save/autosave 配線                      │
│   └─ depends on ─┐                              │
├───────────────────▼──────────────────────────┤
│ packages/core (pure TS — React/Tauri 非依存)     │
│   ・model      ドメイン型 + Zod スキーマ           │
│   ・commands   コア変更コマンド (+ undo 用の逆操作) │
│   ・sync       reconcile（純粋関数・最重要）        │
│   ・persistence ファイル読み書き（IF 越し）         │
│   ・export     出力（IF 越し・将来 Excel）          │
│   ・validate   参照整合性チェック                  │
└──────────────────────────────────────────────┘
```

**最重要方針**: `packages/core` は **React も Tauri も import しない純粋 TS**。
ドメイン・同期・永続化の IF・出力の IF をここに置き、Node 上で単体テストできるようにする。
UI（React）と OS 連携（Rust）は薄いアダプタに留める。

## 3. ディレクトリ構成（予定）

```
gantt-flow/
├── docs/                          # ← 本設計書（現段階の成果物）
├── packages/
│   └── core/                      # 純粋 TS。UI 非依存・単体テスト可能
│       ├── src/
│       │   ├── model/             # ProcessTask, Dependency, Flow*, Project 型 + Zod
│       │   ├── commands/          # addTask, moveTask, setAssignee, addDependency, deleteTask...（+逆操作）
│       │   ├── sync/
│       │   │   ├── reconcileFlow.ts   # 純粋な同期アルゴリズム（最重要）
│       │   │   ├── autoPlace.ts       # 新規ノードの自動配置（レーン×バンド）
│       │   │   ├── bands.ts           # 祖先範囲バンドの導出（ツリー→帯）
│       │   │   └── report.ts          # SyncReport 型
│       │   ├── persistence/
│       │   │   ├── ProjectRepository.ts  # 読み書き IF
│       │   │   ├── json.ts            # Phase1: 単一 JSON
│       │   │   ├── bundle.ts          # Phase3: .gflow ZIP
│       │   │   └── migrations/        # スキーマ移行（純粋関数 + フィクスチャ）
│       │   ├── export/
│       │   │   ├── Exporter.ts        # 出力 IF { id, label, run(project) }
│       │   │   └── excel/             # 将来: ExcelJS 実装
│       │   └── validate.ts
│       └── test/                  # Vitest: 同期のゴールデン/プロパティテスト
├── apps/
│   └── desktop/
│       ├── src-tauri/             # Rust: dialog / atomic fs / autosave / stat 監視
│       └── src/
│           ├── store/             # Zustand（core commands をラップ）
│           ├── table/             # 工程表ビュー（階層アウトライン＋粒度フィルタ）
│           ├── flow/              # @xyflow/react キャンバス・カスタムノード・レーン/バンド
│           ├── shell/             # メニュー・open/save・autosave 配線
│           └── App.tsx
├── package.json                   # npm workspaces
└── README.md
```

## 4. データフロー（編集 → 同期 → 表示）

```
ユーザー操作（表 or フロー）
        │
        ▼
コマンド（commands/*）  ── コアを変更し、必要なら工程表詳細も更新
        │                （undo 用に逆操作を積む）
        ▼
reconcileFlow(core, details, flow, level)  ── 純粋関数。フローを再構築（手動配置・分岐・帳票/課題オブジェクトは保持）
        │
        ▼
Zustand ストア更新 → React 再描画（表・フロー）
        │
        ▼
debounced autosave（Rust 経由でアトミック書き込み）
```

- プロジェクト規模は数十〜低百タスク想定 → 編集ごとに全体 reconcile しても十分高速。実装を単純に保つ。
- すべてのコア変更は**コマンド経由**に統一し、undo/redo の単位とする。

## 5. セキュリティ／オフライン方針

- ネットワークアクセスを行わない（外部送信なし）。Tauri の capability allowlist でファイル系・ダイアログのみ許可。
- データはユーザーが指定したパス（社内共有フォルダ等）にのみ保存。アプリ独自のクラウド同期は持たない。
