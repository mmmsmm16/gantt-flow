# 05. Persistence（保存・ファイル運用）

## 1. 方針

- **ローカルファイルにのみ保存**。クラウド同期・DB サーバは持たない（機密データを共有フォルダ外へ出さない）。
- ユーザーが任意のパス（社内共有フォルダ＝SMB/NFS 等）を指定して開く／保存する**ドキュメント指向**。
- 1 案件＝1 ファイル。コア＋工程表詳細＋フロー詳細を 1 つの開ける／保存できるファイルにまとめる。

## 2. ファイル形式

### Phase 1: 単一 JSON（`.json`）
- まずは `Project`（`02-data-model.md`）をそのまま 1 つの JSON にシリアライズ。実装が軽い。
- `ProjectRepository` IF の背後に実装を隠し、後で差し替え可能にする。

### Phase 3 以降: ZIP バンドル（`.gflow`）
将来、画像等のアセットを同梱したくなったら ZIP バンドルへ拡張する。

```
project.gflow  (ZIP)
├── manifest.json      { schemaVersion, appVersion, title, ids }
├── core.json          Core
├── details.json       Record<taskId, TaskDetail>
├── flow.json          FlowView
└── assets/            （将来: 画像・ロゴ 等）
```

- 利点: 1 ファイルとして共有フォルダへ置ける／メール添付不要、部分復旧しやすい、バイナリ同梱可。
- ユーザー体験は「1 ファイルを開く／保存する」で一貫。

## 3. 共有フォルダでの同時編集と安全な書き込み

SMB/NFS 上では「部分書き込みによる破損」と「複数人の同時編集による上書き喪失」の 2 つを防ぐ必要がある。
ロックサーバを持たないため、**助言ロック（開く時）＋競合検知（保存時）の二重の安全網**で「作業を黙って失わせない」を担保する。

### アトミック保存（破損防止）
- **同一ディレクトリ内**の一時ファイル（`*.tmp-<rand>`）に書き、`fsync` 後に対象へ **rename（原子的置換）**。
  OS の temp ディレクトリは別ボリュームになり rename が原子的でなくなるため使わない。

### 助言ロック（開く時点の検知。2026-06-06 確定）
- ファイルを**編集モードで開く時**、同ディレクトリに `<file>.lock` を**アトミックに作成**
  （tmp→rename で EEXIST 判定。SMB/NFS では `O_EXCL` が不確実なため rename トリックを使う）。
- 内容: `{ user, host, sessionId, openedAt, heartbeatAt, appVersion }`。
- **ハートビート**: 編集中は一定間隔（例 30s）で `heartbeatAt` を書き直す（autosave タイマーに相乗り）。
  クリーン終了・保存完了時にロックを**解放（削除）**。クラッシュ時は残るが `heartbeatAt` が古くなる。
- 既にロックがある状態で開く場合:
  - **新鮮**（`heartbeatAt` がしきい値内＝例 3×間隔=90s）→「○○ が編集中」。**読み取り専用で開く**／別名で開く を提示（本体への上書き保存はさせない）。
  - **古い／自分のクラッシュ残骸**（しきい値超過）→「前回の編集が残っています」。**ロックを引き継いで編集（steal）**を許可。
- ロックは**助言的（advisory）**。排他作成を保証しない FS に備え、下記の保存時検知を**必ず併用**する。

### 競合検知（保存時・最後の安全網）
- 読込時に `meta.updatedAt` ＋セッション乱数を記録。
- 保存直前にディスク上の `updatedAt` を読み直し、読込時から変わっていれば衝突とみなす
  （ロックをすり抜けた場合でもここで捕捉）。

### 衝突時の解決（自動マージしない）
- 構造グラフのため**自動マージは行わない**。ダイアログで提示:
  - **別名保存（推奨デフォルト）**: 自分の版を新ファイルへ。両者の作業を失わない。
  - **上書き保存**: 相手の変更を捨てる（明示確認）。
  - **破棄して再読込**: 自分の未保存変更を捨て、ディスク版を開く。
- 「何が変わったか」の差分要約表示は任意機能として保留。

### 自動保存（名前空間で衝突回避）
- 変更後デバウンス（例 5s）で**サイドカー** `<file>.<user>@<host>.autosave` へ保存
  （2 人が同じ本体を開いても autosave 同士が衝突しない）。本体へは直接 autosave しない。
  次回起動時に新しい autosave があれば復旧を促す。

### 粒度
- ロック・競合検知は**ファイル単位（プロジェクト全体）**。サブ文書ロックは持たない
  （1 案件=1 ファイル・数十〜低百タスクには過剰）。

> これらの I/O（ダイアログ・アトミック書き込み・stat 監視・**ロック作成/ハートビート/解放**・autosave タイマー）は
> **Tauri の Rust 側**で実装し、`packages/core` の `ProjectRepository` IF から呼ぶ。

## 4. スキーマ versioning とマイグレーション

- `manifest.json`（または JSON ルート）に `schemaVersion`（整数）。
- `migrations: Array<(p) => p>` を版の昇順に適用（v1→v2→…）。各マイグレーションは純粋関数＋フィクスチャでテスト。
- **読込時はメモリ上でのみマイグレーションし、明示保存まで書き戻さない**（読み取り専用共有上の古いファイルを安全に開ける）。
- 読込は **Zod** でパースし、型境界を明確化。壊れた参照は `quarantine` へ退避して落とさない（`02-data-model.md` §6）。

## 5. `ProjectRepository` インターフェース（イメージ）

```ts
interface LockInfo {
  user: string; host: string; sessionId: string;
  openedAt: string; heartbeatAt: string; appVersion: string;
}

interface ProjectRepository {
  open(path: string): Promise<{ project: Project; report: LoadReport }>;
  save(path: string, project: Project): Promise<void>;       // アトミック書き込み
  statUpdatedAt(path: string): Promise<string | null>;       // 競合検知用
  writeAutosave(path: string, project: Project, owner: LockInfo): Promise<void>; // 名前空間付きサイドカー

  // --- 同時編集（助言ロック） ---
  acquireLock(path: string, owner: LockInfo):                // 取得 or 既存ロック情報を返す
    Promise<{ ok: true } | { ok: false; held: LockInfo; stale: boolean }>;
  refreshLock(path: string, owner: LockInfo): Promise<void>; // ハートビート（heartbeatAt 更新）
  releaseLock(path: string, owner: LockInfo): Promise<void>; // 解放（削除）
  readLock(path: string): Promise<LockInfo | null>;          // 表示用
}
```

## 6. 取り込み（インポート＝初回ブートストラップ）

### 方針（2026-06-06 確定）
- Excel/CSV 取り込みは **新規プロジェクトを生成する初回ブートストラップ専用**。
  既存プロジェクトへのマージ・再取り込み更新は **行わない**（`07-open-questions.md` §7）。
- **往復（保存・再開）はネイティブ形式（`.json` / `.gflow`）で行う**。ID がファイル内にあるため、
  再オープンでフローの**配置・分岐・I/O/課題オブジェクトを完全保持**（突合不要）。
- 同じ Excel をもう一度取り込むと **別の新規プロジェクト**になる（既存への反映ではない）。
  UI で「新規プロジェクトを作成します」と明示し、誤って配置を失わせない。

> なぜ初回のみか: フローの手動レイアウト/分岐は `taskId` / `ioId` 参照に依存する。
> 外部（Excel）に ID と配置が無い以上、再取り込みでの突合は本質的に脆く、配置喪失リスクが高い。
> 往復をネイティブ形式に一本化することで、この問題を構造的に消す（突合キー不要・最も堅牢）。

### ID 発番
- **Importer は「外部→内部 ID」の発番が起こる唯一の場所**。取り込み時に各
  `ProcessTask` / `IoItem` / `IssueItem` / `Dependency` へ新規 **UUID v4** を発番する。
  以降は通常どおり**アプリ生成 ID が権威**（`02-data-model.md` §6）で、Excel の行番号・工程No 等の
  外部キーには依存しない（フローは UUID 参照のみ）。

### 変換ルール（表 → コア＋詳細）
- 1 行＝1 工程（`ProcessTask`）。粒度列＋階層（インデント/親子）から木を構築。
- 標準/任意列を `TaskDetail` に割当。**I/O 列は区切り（改行等）で複数 `IoItem` に分解**
  （`kind` は粒度から既定：中=doc / 小=info、手修正可）。課題/方策列を `IssueItem[]` に。
- **前/次工程列は取り込み後にまとめて参照解決**して `Dependency` を張る（工程No or 作業名で突合、
  同一粒度・同一親スコープ内）。
- 解決できない参照・粒度矛盾・親不明は**落とさず `ImportReport` に集約**して提示（quarantine と同じ思想）。

### フローの初期生成
- Excel にフロー配置は無いため、取り込み直後に `reconcileFlow` で **autoPlace により決定論的に初期配置**
  （レーン×バンド）。以降ユーザーが手動調整し、ネイティブ保存で保持される。

### インターフェース（イメージ）
```ts
interface ImportReport {
  created: { tasks: number; ios: number; issues: number; dependencies: number };
  unresolvedDeps: Array<{ row: number; ref: string }>;   // 解決できなかった前/次工程参照
  hierarchyIssues: Array<{ row: number; reason: string }>; // 粒度矛盾・親不明
  warnings: string[];
}

interface Importer {
  id: string; label: string;                              // "excel" | "csv"
  run(file: Uint8Array): Promise<{ project: Project; report: ImportReport }>;
}
```
- `export/Exporter.ts` と対になる `import/Importer.ts`（`packages/core`）。
  **純粋関数として単体テスト**（行列フィクスチャ → Project）。往復しないので、書き出し側に ID 列を埋める必要は無い。
