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

## 3. 共有フォルダ向けの安全な書き込み

SMB/NFS 上では部分書き込みがファイル破損につながるため:

- **アトミック保存**: **同一ディレクトリ内**の一時ファイル（`*.tmp-<rand>`）に書き、`fsync` 後に
  対象へ **rename（原子的置換）**。OS の temp ディレクトリは別ボリュームになり rename が原子的でなくなるため使わない。
- **競合検知（advisory）**: ロックサーバを持たないため、
  - 読込時に `meta.updatedAt` ＋セッション乱数を記録。
  - 保存直前にディスク上の `updatedAt` を読み直し、読込時から変わっていれば
    「ファイルがディスク上で変更されています（上書き／再読込／別名保存）」と警告。
- **自動保存**: 変更後デバウンス（例 5 秒）で**サイドカー**（`*.autosave`）へ保存。ユーザー本体ファイルへは直接 autosave しない。
  次回起動時に新しい autosave があれば復旧を促す。

> これらの I/O（ダイアログ・アトミック書き込み・stat 監視・autosave タイマー）は **Tauri の Rust 側**で実装し、
> `packages/core` の `ProjectRepository` IF から呼ぶ。

## 4. スキーマ versioning とマイグレーション

- `manifest.json`（または JSON ルート）に `schemaVersion`（整数）。
- `migrations: Array<(p) => p>` を版の昇順に適用（v1→v2→…）。各マイグレーションは純粋関数＋フィクスチャでテスト。
- **読込時はメモリ上でのみマイグレーションし、明示保存まで書き戻さない**（読み取り専用共有上の古いファイルを安全に開ける）。
- 読込は **Zod** でパースし、型境界を明確化。壊れた参照は `quarantine` へ退避して落とさない（`02-data-model.md` §6）。

## 5. `ProjectRepository` インターフェース（イメージ）

```ts
interface ProjectRepository {
  open(path: string): Promise<{ project: Project; report: LoadReport }>;
  save(path: string, project: Project): Promise<void>;       // アトミック書き込み
  statUpdatedAt(path: string): Promise<string | null>;       // 競合検知用
  writeAutosave(path: string, project: Project): Promise<void>;
}
```
