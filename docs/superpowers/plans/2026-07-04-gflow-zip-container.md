# .gflow ZIP コンテナ化（v2）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.gflow` を「単一 JSON」から「ZIP コンテナ（`project.json` ＋ `assets/`）」へ拡張し、全保存経路（デスクトップ/Tauri/fsstore/MCP）がバイト列で読み書きできるようにする（手順書・画像サイクルの土台）。

**Architecture:** ZIP の組み立て/展開は **純 JS の fflate を `@gantt-flow/core` に追加**して一元化（ブラウザ・Node 両対応）。Rust には zip crate を足さない — `fsstore::atomic_save(&[u8])` / `load()->Vec<u8>` は既にバイト列ネイティブで、文字列前提は Tauri コマンド殻（`save_project`/`open_project`）だけなので、そこを **base64 経由のバイト受け渡し**に変える。既存の文字列 API（`serializeProject`/`deserializeProject`）は変更せず、コンテナ API を**追加**する。

**Tech Stack:** TypeScript (fflate ^0.8) / Rust (base64 0.22) / Tauri 2 / vitest

**設計出典:** `docs/superpowers/specs/2026-07-04-procedure-layer-design.md` の「画像と .gflow の ZIP 束ね化（v2 コンテナ）」節。

## Global Constraints

- `packages/core` は UI/OS 非依存を維持（fflate は純 JS なので可。React/Tauri/ブラウザ API 禁止は不変）。
- **sync/（reconcile）には一切触れない。**
- 旧形式（単一 JSON の `.gflow` / `.json`）は**読み込み後方互換**。**開いただけでは書き戻さない**（明示保存で ZIP になる）。
- `CURRENT_SCHEMA_VERSION` は **bump しない**（コンテナ形式はスキーマと直交。`project.json` の中身は現行スキーマのまま）。
- アトミック保存（tmp→rename）・助言ロック（`<file>.lock` 隣接）の意味論は不変。
- `serializeProject` / `deserializeProject` の既存シグネチャ・利用箇所（autosave.ts / backups.ts / 既存テスト）は変更しない。localStorage 系のクラッシュ復旧は JSON 文字列のまま（資産は将来サイクルで判断）。
- ZIP 出力は**バイト安定**: 全エントリ mtime を `new Date(0)` に固定、assets はキーをソートして格納、`project.json` が先頭。
- コミットメッセージは日本語 conventional 風（`feat:`/`fix:`/`docs:`）。`git add` は**明示パス**のみ。
- レビュー傾斜: Task 1（形式の核）は専任レビュー、Task 2/4 はコントローラの直接 diff 監査で可。フルワークスペーステストは Task 5 の最終 1 回。
- **Task 3（desktop persistence.ts）は feature/ux-polish-1 / feature/milestone の PR マージ→本ブランチの rebase 後に着手**（persistence.ts の衝突回避）。行番号は rebase 後にずれるため、Task 3 はシンボル名で探すこと。

## File Structure

- 新規: `packages/core/src/persistence/container.ts`（コンテナ形式の唯一の実装）
- 新規: `packages/core/test/container.test.ts`
- 新規: `apps/desktop/src/b64.ts`（IPC 用 base64 ヘルパ）
- 変更: `packages/core/src/index.ts`（エクスポート追加）、`packages/core/package.json`（fflate）
- 変更: `apps/desktop/src-tauri/src/main.rs`（save/open コマンドのバイト化）、`apps/desktop/src-tauri/Cargo.toml`（base64）
- 変更: `apps/desktop/src/persistence.ts`（保存/読込/外部変更検知のバイト化）、`apps/desktop/test/persistence.test.ts`
- 変更: `apps/mcp-server/src/fileio.ts`、`apps/mcp-server/test/session.test.ts`
- 変更: `CLAUDE.md`（.gflow 形式の記述更新・Task 5）

---

### Task 1: core コンテナ API（container.ts）

**Files:**
- Create: `packages/core/src/persistence/container.ts`
- Create: `packages/core/test/container.test.ts`
- Modify: `packages/core/src/index.ts`（persistence のエクスポート行の並びに `container` を追加）
- Modify: `packages/core/package.json`（`dependencies` に `"fflate": "^0.8.2"`）

**Interfaces:**
- Consumes: `serializeProject` / `deserializeProject` / `DeserializeOptions`（`./json`）
- Produces（後続タスクが依存する正確な API）:
  - `serializeContainer(project: Project, assets?: Record<string, Uint8Array>): Uint8Array`
  - `deserializeContainer(bytes: Uint8Array, opts?: DeserializeOptions): ContainerData`
  - `tryDeserializeContainer(bytes, opts?): { ok: true; data: ContainerData } | { ok: false; error: unknown }`
  - `detectContainerFormat(bytes: Uint8Array): 'zip' | 'json' | null`
  - `interface ContainerData { project: Project; assets: Record<string, Uint8Array>; format: 'zip' | 'json' }`
  - `ContainerFormatError` / `isContainerFormatError`（name ベース判定・バンドル境界安全）

- [ ] **Step 1: fflate を core の dependencies に追加**

```bash
npm install fflate@^0.8.2 -w @gantt-flow/core
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/core/test/container.test.ts`。プロジェクトのフィクスチャは既存の
`packages/core/test/persistence.test.ts` と同じ生成手段（helpers）を**先に読んで**合わせること。
以下のアサーションが規範:

```ts
import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import {
  ContainerFormatError, deserializeContainer, detectContainerFormat,
  serializeContainer, tryDeserializeContainer,
} from '../src/persistence/container';
import { serializeProject } from '../src/persistence/json';

describe('container', () => {
  it('ZIP ラウンドトリップ: serialize→deserialize が deep-equal / format=zip', () => {
    const p = makeProject(); // 既存テストのフィクスチャ生成に合わせる
    const bytes = serializeContainer(p);
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    const out = deserializeContainer(bytes);
    expect(out.format).toBe('zip');
    expect(out.project).toEqual(p);
    expect(out.assets).toEqual({});
  });

  it('assets ラウンドトリップ: バイト列がそのまま戻る', () => {
    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const bytes = serializeContainer(makeProject(), { 'img-001.png': img });
    const out = deserializeContainer(bytes);
    expect(Object.keys(out.assets)).toEqual(['img-001.png']);
    expect(Array.from(out.assets['img-001.png'])).toEqual(Array.from(img));
  });

  it('旧形式（単一 JSON バイト列）を読める / format=json', () => {
    const p = makeProject();
    const out = deserializeContainer(strToU8(serializeProject(p)));
    expect(out.format).toBe('json');
    expect(out.project).toEqual(p);
  });

  it('UTF-8 BOM 付き旧 JSON も読める', () => {
    const p = makeProject();
    const raw = strToU8(serializeProject(p));
    const withBom = new Uint8Array(raw.length + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(raw, 3);
    expect(deserializeContainer(withBom).project).toEqual(p);
  });

  it('出力はバイト安定（同一入力→同一バイト列）', () => {
    const p = makeProject();
    const a = serializeContainer(p, { 'b.png': new Uint8Array([2]), 'a.png': new Uint8Array([1]) });
    const b = serializeContainer(p, { 'a.png': new Uint8Array([1]), 'b.png': new Uint8Array([2]) });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('project.json の無い ZIP / 不明形式は ContainerFormatError', () => {
    const noEntry = serializeContainerLikeWithout(); // fflate zipSync({'x.txt': ...}) で自作
    expect(() => deserializeContainer(noEntry)).toThrowError(ContainerFormatError);
    expect(detectContainerFormat(new Uint8Array([0, 1, 2]))).toBeNull();
    const r = tryDeserializeContainer(new Uint8Array([0, 1, 2]));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `npm test -w @gantt-flow/core -- container`
Expected: FAIL（モジュール未実装）

- [ ] **Step 4: container.ts を実装**

```ts
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Project } from '../model/types';
import { deserializeProject, serializeProject, type DeserializeOptions } from './json';

export const PROJECT_ENTRY = 'project.json';
export const ASSETS_DIR = 'assets/';

export type ContainerFormat = 'zip' | 'json';

export interface ContainerData {
  project: Project;
  /** ZIP 内 assets/ 配下（キーは assets/ を除いた相対名） */
  assets: Record<string, Uint8Array>;
  /** 読み込んだファイルの形式。json = 旧単一 JSON（後方互換） */
  format: ContainerFormat;
}

export class ContainerFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerFormatError';
  }
}

export function isContainerFormatError(e: unknown): e is ContainerFormatError {
  return e instanceof Error && e.name === 'ContainerFormatError';
}

const BOM = [0xef, 0xbb, 0xbf] as const;

function stripBom(bytes: Uint8Array): Uint8Array {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
    ? bytes.subarray(3)
    : bytes;
}

/** 先頭バイトで形式判定。UTF-8 BOM・先頭空白は許容。 */
export function detectContainerFormat(bytes: Uint8Array): ContainerFormat | null {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  const body = stripBom(bytes);
  let i = 0;
  while (i < body.length && (body[i] === 0x20 || body[i] === 0x09 || body[i] === 0x0a || body[i] === 0x0d)) i++;
  return i < body.length && body[i] === 0x7b ? 'json' : null;
}

/** バイト安定な ZIP を生成（mtime 固定・assets キーソート・project.json 先頭）。 */
export function serializeContainer(project: Project, assets: Record<string, Uint8Array> = {}): Uint8Array {
  const mtime = new Date(0);
  const entries: Zippable = {
    [PROJECT_ENTRY]: [strToU8(serializeProject(project)), { level: 6, mtime }],
  };
  for (const name of Object.keys(assets).sort()) {
    // 画像等は再圧縮の益が薄いので store（level 0）
    entries[ASSETS_DIR + name] = [assets[name], { level: 0, mtime }];
  }
  return zipSync(entries);
}

export function deserializeContainer(bytes: Uint8Array, opts?: DeserializeOptions): ContainerData {
  const format = detectContainerFormat(bytes);
  if (format === 'json') {
    return { project: deserializeProject(strFromU8(stripBom(bytes)), opts), assets: {}, format };
  }
  if (format === 'zip') {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch (e) {
      throw new ContainerFormatError(`ZIP の展開に失敗しました: ${String(e)}`);
    }
    const entry = files[PROJECT_ENTRY];
    if (!entry) throw new ContainerFormatError(`コンテナ内に ${PROJECT_ENTRY} がありません`);
    const assets: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(files)) {
      if (path.startsWith(ASSETS_DIR) && path.length > ASSETS_DIR.length && !path.endsWith('/')) {
        assets[path.slice(ASSETS_DIR.length)] = data;
      }
    }
    return { project: deserializeProject(strFromU8(entry), opts), assets, format };
  }
  throw new ContainerFormatError('不明なファイル形式です（.gflow として読めません）');
}

export function tryDeserializeContainer(
  bytes: Uint8Array,
  opts?: DeserializeOptions,
): { ok: true; data: ContainerData } | { ok: false; error: unknown } {
  try {
    return { ok: true, data: deserializeContainer(bytes, opts) };
  } catch (error) {
    return { ok: false, error };
  }
}
```

- [ ] **Step 5: index.ts からエクスポート**

`packages/core/src/index.ts` の persistence エクスポート群（`export * from './persistence/json'` 等）の並びに追加:

```ts
export * from './persistence/container';
```

（既存が named export 方式ならそれに合わせる。）

- [ ] **Step 6: テスト・型チェック**

Run: `npm test -w @gantt-flow/core -- container` → PASS（全ケース）
Run: `npm test -w @gantt-flow/core` → 既存テストも全緑
Run: `npm run typecheck -w @gantt-flow/core` → クリーン

- [ ] **Step 7: コミット**

```bash
git add packages/core/src/persistence/container.ts packages/core/test/container.test.ts packages/core/src/index.ts packages/core/package.json package-lock.json
git commit -m "feat(core): .gflow v2 ZIP コンテナ形式 (project.json+assets、旧JSON後方互換)"
```

---

### Task 2: Tauri コマンドのバイト化（base64 IPC）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`（`save_project` / `open_project` の 2 コマンドのみ）
- Modify: `apps/desktop/src-tauri/Cargo.toml`

**Interfaces:**
- Produces（Task 3 が依存する IPC 契約）:
  - `save_project(path: String, contents_b64: String)` — JS 側キーは `{ path, contentsB64 }`
  - `open_project(path: String) -> String`（**base64 文字列**を返す。旧: UTF-8 JSON 文字列）
- 他のコマンド（stat/lock/pick 系）は無変更。`ensure_allowed`・`AllowedPaths`・async 化も既存のまま。

- [ ] **Step 1: Cargo.toml に base64 を追加**

`apps/desktop/src-tauri/Cargo.toml` の `[dependencies]` に:

```toml
base64 = "0.22"
```

- [ ] **Step 2: 2 コマンドを書き換え**

`main.rs` 冒頭の use 群に追加:

```rust
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
```

既存の `save_project`（現行: `contents: String` → `contents.as_bytes()`）を:

```rust
#[tauri::command]
async fn save_project(
    path: String,
    contents_b64: String,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<(), String> {
    ensure_allowed(&path, &allowed)?;
    let bytes = B64
        .decode(contents_b64.as_bytes())
        .map_err(|e| format!("base64 decode error: {e}"))?;
    fsstore::atomic_save(std::path::Path::new(&path), &bytes).map_err(|e| e.to_string())
}
```

既存の `open_project`（現行: `String::from_utf8(bytes)`）を:

```rust
#[tauri::command]
async fn open_project(
    path: String,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<String, String> {
    ensure_allowed(&path, &allowed)?;
    let bytes = fsstore::load(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    Ok(B64.encode(&bytes))
}
```

（既存コードの `ensure_allowed` 呼び出し形・エラー変換のスタイルに正確に合わせること。
`invoke_handler![...]` の登録名は変わらないので変更不要。）

- [ ] **Step 3: ビルド確認**

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: エラーなし（警告があれば内容を報告）
Run: `cargo test --manifest-path crates/fsstore/Cargo.toml`
Expected: 既存 14 テスト全緑（fsstore は無変更の確認）

- [ ] **Step 4: コミット**

```bash
git add apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat(tauri): save/open コマンドを base64 バイト列 IPC 化 (ZIP コンテナ対応)"
```

**注意:** この時点でデスクトップ JS 側は旧文字列のままなので、Tauri 実機では Task 3 完了まで保存/読込が噛み合わない（開発は Vite ブラウザモードで継続可能）。Task 2 と Task 3 の間にユーザ実機評価を挟まないこと。

---

### Task 3: デスクトップ persistence.ts のバイト化（★ rebase 後に着手）

**前提: feature/ux-polish-1 と feature/milestone のマージ後、本ブランチを main に rebase してから着手。**
行番号はずれている前提で、シンボル名で編集箇所を特定すること。

**Files:**
- Create: `apps/desktop/src/b64.ts`
- Modify: `apps/desktop/src/persistence.ts`
- Modify: `apps/desktop/test/persistence.test.ts`

**Interfaces:**
- Consumes: Task 1 の `serializeContainer`/`deserializeContainer`、Task 2 の IPC 契約（`contentsB64` / base64 戻り値）
- Produces: 外部 API（`saveProjectToFile`/`openProjectFromFile`/`startExternalWatch` 等）のシグネチャは**不変**

- [ ] **Step 1: b64.ts を作成**

```ts
/** Uint8Array ⇄ base64（Tauri IPC 用。スタック上限を避けるためチャンク処理） */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

- [ ] **Step 2: persistence.ts の書き換え（編集箇所の全列挙）**

1. import に `serializeContainer, deserializeContainer`（`@gantt-flow/core`）と `bytesToB64, b64ToBytes`（`./b64`）を追加。
2. `doSave`: `const json = serializeProject(project)` → `const bytes = serializeContainer(project)`。
   以降 `json` を使う 3 分岐（Tauri / FS-Access `w.write(json)` / `download(...)`）をすべて `bytes` に。
   `download` の mime は `'application/json'` → `'application/octet-stream'`。
3. `saveTauri`: `invoke<null>('save_project', { path, contents: json })` →
   `invoke<null>('save_project', { path, contentsB64: bytesToB64(bytes) })`（引数名変更に注意）。
4. `openProjectFromFile`（Tauri 分岐）: `const text = await invoke<string>('open_project', { path })` →
   `const b64 = await invoke<string>('open_project', { path }); const project = deserializeContainer(b64ToBytes(b64)).project;`
5. `pollExternal`（外部変更検知）: 同じ変換（`invoke<string>('open_project')` → b64 → `deserializeContainer(...).project`）。
6. ブラウザ読込 3 箇所（FS-Access の `file.text()` / `<input type=file>` フォールバック）:
   `await file.text()` → `new Uint8Array(await file.arrayBuffer())` → `deserializeContainer(buf).project`。
7. `downloadProjectJson`（クラッシュ退避）は**変更しない**（旧 JSON も正規の読める形式のまま）。
8. `autosave.ts` / `backups.ts` は**変更しない**。
9. `serializeProject`/`deserializeProject` の import が persistence.ts に残らない場合は整理
   （`downloadProjectJson` が使うなら残る）。

- [ ] **Step 3: デスクトップ persistence テストを更新**

`apps/desktop/test/persistence.test.ts` の invoke モック:
- `save_project` ハンドラ: `args.contentsB64` を受け、`b64ToBytes` → `deserializeContainer` でプロジェクトに戻せることを検証（`bytes[0]===0x50 && bytes[1]===0x4b` で ZIP ヘッダも確認）。
- `open_project` ハンドラ: ① `serializeContainer(fixture)` の base64 を返すケース（v2 読込）
  ② `strToU8(serializeProject(fixture))` 相当の base64 を返すケース（**旧 JSON 後方互換**）の両方。
- 既存の mtime 競合・ロックのテストはモック戻り値の形式だけ合わせて維持。

- [ ] **Step 4: テスト・型チェック**

Run: `npm test -w @gantt-flow/desktop` → 全緑
Run: `npm run typecheck -w @gantt-flow/desktop` → クリーン

- [ ] **Step 5: コミット**

```bash
git add apps/desktop/src/b64.ts apps/desktop/src/persistence.ts apps/desktop/test/persistence.test.ts
git commit -m "feat(desktop): .gflow 保存/読込/外部変更検知を ZIP コンテナ (バイト列) 対応に"
```

---

### Task 4: MCP サーバの fileio バイト化

**Files:**
- Modify: `apps/mcp-server/src/fileio.ts`
- Modify: `apps/mcp-server/test/session.test.ts`（後方互換ケース追加）

**Interfaces:**
- Consumes: Task 1 の `serializeContainer`/`deserializeContainer`
- Produces: `loadProjectFile(path): Promise<Project>` / `saveProjectFile(path, project): Promise<void>`（シグネチャ不変 — session.ts は無修正）

- [ ] **Step 1: fileio.ts を書き換え**

```ts
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { deserializeContainer, serializeContainer, type Project } from '@gantt-flow/core';
// tmp 名生成・エラーハンドリングは既存実装のまま維持すること

export async function loadProjectFile(path: string): Promise<Project> {
  const buf = await readFile(path); // encoding 指定なし = Buffer
  return deserializeContainer(new Uint8Array(buf)).project;
}

export async function saveProjectFile(path: string, project: Project): Promise<void> {
  const bytes = serializeContainer(project);
  // 既存の tmp 命名規則 (.{basename}.tmp-{pid}-{time}) と rename / 失敗時 unlink をそのまま使う。
  // writeFile(tmp, bytes) — encoding 指定を外すだけ。
}
```

（既存ファイルの構造を保ち、`'utf8'` 指定の除去と serialize/deserialize の差し替えを最小差分で行う。）

- [ ] **Step 2: 後方互換テストを追加**

`session.test.ts` に: 一時ディレクトリへ**旧形式**を直接書く → `ProjectSession.open` が読める → `apply` 1 回 → ファイル先頭 2 バイトが `PK`（ZIP 化された）→ `reload()` が deep-equal。

```ts
it('旧 JSON ファイルを開け、保存で v2 (ZIP) になる', async () => {
  const file = join(dir, 'legacy.gflow');
  await writeFile(file, serializeProject(project), 'utf8');
  const s = await ProjectSession.open(file);
  await s.apply(/* 既存テストと同じ軽い編集 */);
  const head = new Uint8Array(await readFile(file)).subarray(0, 2);
  expect(Array.from(head)).toEqual([0x50, 0x4b]);
  expect((await ProjectSession.open(file)).project).toEqual(s.project);
});
```

- [ ] **Step 3: テスト**

Run: `npm test -w @gantt-flow/mcp` → 全緑（既存の write-through テスト含む）
Run: `npm run build -w @gantt-flow/mcp` → ビルド成功

- [ ] **Step 4: コミット**

```bash
git add apps/mcp-server/src/fileio.ts apps/mcp-server/test/session.test.ts
git commit -m "feat(mcp): プロジェクト読み書きを ZIP コンテナ対応に (旧JSONは読込後方互換)"
```

---

### Task 5: 総合検証・ドキュメント同期

**Files:**
- Modify: `CLAUDE.md`（「現用の `.gflow` は単一 JSON」の記述を v2 コンテナに更新）
- Modify: `docs/superpowers/specs/2026-07-04-procedure-layer-design.md`（ZIP 節に「実装済み」注記は不要 — 変更なしなら触らない）

- [ ] **Step 1: CLAUDE.md の乖離注記を更新**

「ドキュメントと実装の乖離」内の `.gflow` 記述を:

> `docs/05` の `.gflow` ZIP バンドルは **v2 として実装済み**（`project.json`＋`assets/`、
> `packages/core/src/persistence/container.ts`）。旧単一 JSON（`.gflow`/`.json`）は読み込み後方互換で、
> 明示保存時に v2 になる。

の趣旨で現状に合わせて書き換え（正確な現文言に合わせて最小編集）。

- [ ] **Step 2: フルスイープ（このサイクル唯一の全体実行）**

Run: `npm test --workspaces` → 全緑
Run: `npm run typecheck --workspaces` → クリーン
Run: `cargo test --manifest-path crates/fsstore/Cargo.toml` && `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` → 全緑

- [ ] **Step 3: 実ファイル ラウンドトリップ確認（Node スクリプト）**

scratchpad に使い捨てスクリプトを書き、ビルド済み core で:
サンプルプロジェクト → `serializeContainer` → 実ファイル書き込み → 読み戻し → deep-equal、
および旧 JSON ファイル → 読める、を確認（結果はレポートに記載）。

- [ ] **Step 4: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: .gflow v2 (ZIP コンテナ) 化に伴う CLAUDE.md 更新"
```

- [ ] **Step 5: 最終レビュー**

- migration-safety-reviewer エージェント（persistence/load-save 変更のため必須）
- opus によるブランチ全体レビュー（`git merge-base` からの review-package）
