# 手順書タブ（Manual 層）実装計画（サイクル2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. コア（Task 1/2）は TDD（失敗テスト→実装→緑→コミット）で進めること。

**Goal:** `.gflow` に新設トップレベル `project.manual`（`procedures` ＝末端工程ごとの手順書 ／ `assets` ＝資料台帳）を足し、表・フローに続く第 3 のビュー「手順書タブ」を実装する。中工程を開くと、サイドバーに配下末端工程の縦フローナビ、本文に各工程の目的・ステップ（アクション／目的／詳細本文 Markdown／条件＋飛び先／参照チップ／画像）が並ぶ。単一データソース同期は維持し、AI（MCP）が構造のまま読み書きできる。UI の正は `design_reference/procedure-mock.html`。

**Architecture:**
- **モデルは `@gantt-flow/core` に集約**。`manual` は core/details と独立したトップレベルで、**reconcile（flow 同期）に一切関与しない**。全編集は純粋コマンド `(project, args, idGen?, now?) => project'` で、**core / details / manual のみ更新し flow は触らない**（この規約拡張を CLAUDE.md にも反映＝Task 7）。
- **`reconcileProject` は無変更**。既存の `structuredClone({ ...project, flow: {...} })`（`reconcileProject.ts:23`）が `manual` をそのまま温存する挙動に依存する（＝手順書は同期で消えない）。
- **`CURRENT_SCHEMA_VERSION` を 2 に bump**。v1→v2 マイグレーション＝ `manual: { procedures: {}, assets: {} }` の付与（add-migration の流儀：fixture→`migrate()`→現行形 deep-equal、現行版 no-op）。マイグレーションはメモリ上のみ・明示保存まで書き戻さない。
- **画像はセッション中メモリ保持方式**。Project には `StepImage.file`（内容ハッシュ由来名）だけを持ち、実バイトは desktop の `assetStore`（メモリ層）に保持。描画は blob URL。保存時は「現 project から参照される分のみ」を ZIP `assets/` へ書き、メモリは消さない（保存後の undo でも画像が生きる）。localStorage の autosave/backups には画像を含めない（復旧時は画像欠落を許容・ドキュメント化）。二窓同期は画像追加時に bytes を BroadcastChannel で相手窓へ配布（structured clone で `Uint8Array` 可）。取得は DOM の paste イベント（`ClipboardEvent.clipboardData.files`）＋ファイル選択（capability 追加不要）。
- **縦フローナビは純関数 `deriveProcedureNav`**（`bands`/`milestoneGuides` 同型・保存しない・決定論）。中工程配下の末端工程を依存＋order でトポロジカル直列化し、同一レイヤは `∥並行` フラグにする。
- **Markdown は自前の最小レンダラ**（`markdownLite.tsx`）。React 要素を組み立てる方式で `dangerouslySetInnerHTML` 禁止＝XSS 安全。依存追加しない。

**Tech Stack:** TypeScript（core は純 TS・依存追加なし） / React 18 + Zustand 4（desktop） / vitest / fast-check（既存） / MCP（`@modelcontextprotocol/sdk` + zod・既存）

**設計出典:** `docs/superpowers/specs/2026-07-04-procedure-layer-design.md`（本サイクル＝「ビルド順序 2: 手順書タブ」）／ `.superpowers/sdd/procedure-tab-map.md`（コード地図）／ `design_reference/procedure-mock.html`（UI の正）。

## Global Constraints

- **`packages/core` は UI/OS 非依存を維持**。React / Tauri / ブラウザ専用 API を core に持ち込まない（`markdownLite.tsx` は desktop 側）。
- **`sync/reconcileFlow.ts` / `sync/reconcileProject.ts` / `sync/autoPlace.ts` / `sync/tidy.ts` / `sync/bands.ts` などフロー同期・整列は一切触らない。** `reconcileProject` の manual 温存挙動に依存するだけ（変更しない）。
- **commands の更新範囲規約を「core / details / manual のみ・flow 不可」に拡張**（CLAUDE.md ルール 2 の更新は Task 7）。
- **ID 生成は必ず `idGen`（`IdGen`）を注入**。core で直接 UUID を呼ばない。テストは `counter()`（`test/helpers.ts`）＋**固定 `now`（`'2026-07-05T00:00:00.000Z'`）**を注入し出力をバイト安定にする。
- **`manual` は Project の必須フィールド**にする。型を必須にすると Project リテラル全構築点が型エラーになるため、**Task 1 で全構築点に `manual: { procedures: {}, assets: {} }` を一括追加**する（後続タスクが常に compile できる状態から始める）。
- **本サイクルは Rust/Tauri 側の変更ゼロ**。場所エイリアスの実フォルダ登録はテキスト入力（`gf-location-aliases-v1` localStorage）＋「パスをコピー」ボタンで代替。**フォルダ選択ダイアログ・リンク実在検査・リンクを開く機能は将来サイクル（現場モード）へ対象外化**。
- **新しい store アクションは必ず `dualwindow.ts` の `ACTION_CLASS` へ 1 行足す**（データ変更＝`'forward'`）。`apps/desktop/test/dualwindow.test.ts` が「全 store アクションが分類済み」を機械 assert する安全網。ビュー状態（`useUI` の `mainView` 等）は store アクションでないので対象外。
- **UI タスク（Task 4/5/6）は実装者自身が puppeteer-core（`mcp__claude-in-chrome` でも可）で実画面のスクリーンショット確認を完了条件に含める**。Vite ブラウザモード（`npm run dev -w @gantt-flow/desktop`, http://localhost:5173）で検証。
- **UI セルフチェック（Task 4/6 のディスパッチ条件）:** リネーム（onBlur コミット）／ダブルクリック編集／右クリック文脈／キーボード操作／Delete（選択ステップのみ・グローバル暴発しない）／選択・スクロール追従／パン等の既存操作を壊さないこと。
- コミットメッセージは日本語 conventional（`feat:`/`fix:`/`docs:`）。`git add` は**明示パス**のみ。
- **レビュー傾斜:** Task 1 は **migration-safety-reviewer 必須**（schema bump）。Task 2/4/6 は専任レビュー（code-review）。Task 1/3/5 はコントローラの直接 diff 監査で可。**フルワークスペーステスト（`npm test --workspaces` / `npm run typecheck --workspaces`）は Task 7 の 1 回のみ**。各タスク内は当該ワークスペースのテスト/型チェックに限る。
- **依存: 1 → 2 → (3 ∥ 4) → 5 → 6 → 7。** Task 3（MCP）と Task 4（UI）はファイル素が別で並列可。

## File Structure

**新規（core）**
- `packages/core/src/commands/manual.ts` — 手順書・資料台帳の純粋コマンド群（Task 2）
- `packages/core/src/sync/procedureNav.ts` — `deriveProcedureNav`（Task 2）
- `packages/core/src/manualAssets.ts` — `collectReferencedAssetFiles`（Task 6・純関数）
- `packages/core/test/manual-commands.test.ts` / `procedureNav.test.ts` / `validate-procedure.test.ts`（Task 2）
- （Task 1 の container/migration テストは既存ファイルへ追記）

**新規（desktop）**
- `apps/desktop/src/ProcedureView.tsx`（Task 4）
- `apps/desktop/src/markdownLite.tsx`（Task 4）
- `apps/desktop/src/AssetLedger.tsx`（Task 5・資料台帳ドロワー）
- `apps/desktop/src/locationAliases.ts`（Task 5・`gf-location-aliases-v1`）
- `apps/desktop/src/assetStore.ts`（Task 6・画像メモリ層）

**変更（core）**
- `packages/core/src/model/types.ts` / `model/schema.ts` / `persistence/migrate.ts` / `validate.ts` / `commands/index.ts` / `index.ts` / `sample.ts` / `templates.ts` / `import/importCsv.ts` / `persistence/container.ts` / `test/helpers.ts`

**変更（desktop）**
- `apps/desktop/src/store.ts` / `ui/useUI.ts` / `dualwindow.ts` / `App.tsx` / `keymap.ts` / `ui/useGlobalHotkeys.ts` / `ui/CommandPalette.tsx` / `persistence.ts` / `styles.css`

**変更（mcp）**
- `apps/mcp-server/src/tools.ts` / `batch.ts` / `format.ts` / `fileio.ts` / `session.ts`

**変更（docs/config）**
- `CLAUDE.md` / `docs/05-persistence.md`

---

### Task 1 — core モデル・スキーマ・v2 マイグレーション（+ container 繰越）

**Files:**
- Modify: `packages/core/src/model/types.ts`（`Manual` 系型 ＋ `Project.manual`）
- Modify: `packages/core/src/model/schema.ts`（Zod）
- Modify: `packages/core/src/persistence/migrate.ts`（`CURRENT_SCHEMA_VERSION=2` ＋ Migration）
- Modify: `packages/core/src/persistence/container.ts`（assets の path traversal ガード）
- Modify: 全 Project リテラル構築点に `manual` を追加:
  `packages/core/src/sample.ts`(≈170) / `templates.ts`(builder `finish`, ≈52) / `import/importCsv.ts`(≈107) / `test/helpers.ts`(`emptyProject`, 10) / `apps/desktop/src/store.ts`(`initialProject`, 249) / `apps/mcp-server/src/session.ts`(`emptyProject`, 28)
- Modify: `packages/core/test/persistence.test.ts`（v1→v2 マイグレーション往復）
- Modify: `packages/core/test/container.test.ts`（繰越 2 件 ＋ traversal ガード）
- Modify: `packages/core/src/index.ts`（既に `container`/`schema`/`migrate` を re-export 済み。追加不要）

**Interfaces（Produces — spec「データモデル」節の TS を正として転記）:**

```ts
// model/types.ts に追記
export interface Manual {
  procedures: Record<Id, ProcedureDoc>; // key = taskId（末端工程）
  assets: Record<Id, AssetRef>;         // 資料台帳
}
export interface ProcedureDoc {
  taskId: Id;
  purpose?: string;        // 目的（1 文）
  steps: ProcedureStep[];
  updatedAt: string;       // 最終改訂日時（ISO）
  revisions: Revision[];   // 軽量改訂履歴（追記式）
}
export interface ProcedureStep {
  id: Id;
  action: string;          // アクション（1 文）
  why?: string;            // このステップの目的（1 文）
  bodyMd?: string;         // 詳細本文・ノウハウ（Markdown）
  conds: StepCond[];
  refs: StepRef[];
  images: StepImage[];
}
export interface StepCond { id: Id; when: string; thenMd: string; targetTaskId?: Id }
export type StepRef =
  | { kind: 'asset'; assetId: Id }             // 資料台帳
  | { kind: 'io'; taskId: Id; ioId: Id }       // 帳票（IoItem）
  | { kind: 'task'; taskId: Id };              // 他工程
export interface StepImage {
  id: Id;
  file: string;            // ZIP 内 assets/… の相対名（内容ハッシュ由来）
  caption?: string;
  overlay?: unknown;       // 注釈レイヤの席のみ予約（実装しない）
}
export interface Revision { at: string; note?: string; by?: string }
export type AssetLocator = { alias: string; relPath: string } | { url: string };
export interface AssetRef { id: Id; name: string; desc?: string; locator?: AssetLocator }

// Project に必須で追加
export interface Project {
  schemaVersion: number;
  meta: ProjectMeta;
  core: Core;
  details: Record<Id, TaskDetail>;
  flow: FlowView;
  manual: Manual;          // ← 追加（必須）
  quarantine?: unknown[];
}
```

- [ ] **Step 1: 失敗するマイグレーションテストを書く**（`test/persistence.test.ts` に追記）

`add-migration` スキルの流儀に従う。既存テストの記法に合わせること。

```ts
import { migrate, CURRENT_SCHEMA_VERSION } from '../src/persistence/migrate';

describe('migration v1 -> v2 (manual)', () => {
  const v1 = {
    schemaVersion: 1,
    meta: { id: 'p', title: 't', createdAt: '', updatedAt: '', appVersion: '0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
  };
  it('CURRENT_SCHEMA_VERSION は 2', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });
  it('v1 に manual を付与して v2 へ', () => {
    const out = migrate(structuredClone(v1));
    expect(out.schemaVersion).toBe(2);
    expect(out.manual).toEqual({ procedures: {}, assets: {} });
  });
  it('現行版(v2)は no-op（manual を上書きしない）', () => {
    const v2 = { ...structuredClone(v1), schemaVersion: 2, manual: { procedures: { a: { taskId: 'a', steps: [], updatedAt: '', revisions: [] } }, assets: {} } };
    const out = migrate(structuredClone(v2));
    expect(out).toEqual(v2);
  });
  it('serialize→deserialize 往復で manual が保持される', () => {
    // 既存の serializeProject/deserializeProject を使い、manual 付き Project の round-trip を検証
  });
});
```

- [ ] **Step 2: 失敗する container 繰越 ＋ traversal テストを書く**（`test/container.test.ts` に追記）

```ts
import { strToU8, zipSync } from 'fflate';
import { serializeContainer, deserializeContainer } from '../src/persistence/container';

it('assets サブディレクトリ名 (a/b.png) が往復する', () => {
  const img = new Uint8Array([1, 2, 3]);
  const bytes = serializeContainer(makeProject(), { 'a/b.png': img });
  const out = deserializeContainer(bytes);
  expect(Object.keys(out.assets)).toEqual(['a/b.png']);
  expect(Array.from(out.assets['a/b.png'])).toEqual([1, 2, 3]);
});

it('assets 省略 ≡ {} でバイト同一', () => {
  const p = makeProject();
  expect(Array.from(serializeContainer(p))).toEqual(Array.from(serializeContainer(p, {})));
});

it('assets の .. / 絶対パスのエントリを無視する（path traversal 予防）', () => {
  const evil = zipSync({
    'project.json': strToU8(serializeProject(makeProject())),
    'assets/ok.png': new Uint8Array([9]),
    'assets/../evil.png': new Uint8Array([6, 6, 6]),
    'assets//abs.png': new Uint8Array([7]),
  });
  const out = deserializeContainer(evil);
  expect(Object.keys(out.assets)).toEqual(['ok.png']); // evil/abs は落とす
});
```

- [ ] **Step 3: テストが落ちることを確認** — `npm test -w @gantt-flow/core -- persistence container` → FAIL

- [ ] **Step 4: 型を追加**（`model/types.ts`）— 上記 Interfaces の TS を転記。`Project.manual` を必須で追加。

- [ ] **Step 5: Zod スキーマを追加**（`model/schema.ts`）— `ProjectSchema` に `manual` を必須で追加:

```ts
const StepCond = z.object({ id: z.string(), when: z.string(), thenMd: z.string(), targetTaskId: z.string().optional() });
const StepRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), assetId: z.string() }),
  z.object({ kind: z.literal('io'), taskId: z.string(), ioId: z.string() }),
  z.object({ kind: z.literal('task'), taskId: z.string() }),
]);
const StepImage = z.object({ id: z.string(), file: z.string(), caption: z.string().optional(), overlay: z.unknown().optional() });
const ProcedureStep = z.object({
  id: z.string(), action: z.string(), why: z.string().optional(), bodyMd: z.string().optional(),
  conds: z.array(StepCond), refs: z.array(StepRef), images: z.array(StepImage),
});
const Revision = z.object({ at: z.string(), note: z.string().optional(), by: z.string().optional() });
const ProcedureDoc = z.object({
  taskId: z.string(), purpose: z.string().optional(),
  steps: z.array(ProcedureStep), updatedAt: z.string(), revisions: z.array(Revision),
});
const AssetRef = z.object({
  id: z.string(), name: z.string(), desc: z.string().optional(),
  locator: z.union([z.object({ alias: z.string(), relPath: z.string() }), z.object({ url: z.string() })]).optional(),
});
const Manual = z.object({
  procedures: z.record(z.string(), ProcedureDoc),
  assets: z.record(z.string(), AssetRef),
});
// ProjectSchema に: manual: Manual,
```
**注意:** Zod の素の `z.object` は未知キーを strip する。`migrate()` は Zod parse の**前**（`json.ts:77`）に走るため、v1→v2 で manual が付与済み。よって manual を必須にしても旧ファイルは通る。

- [ ] **Step 6: マイグレーションを追加**（`persistence/migrate.ts`）:

```ts
export const CURRENT_SCHEMA_VERSION = 2;
export const migrations: Migration[] = [
  {
    to: 2,
    up: (raw) => ({
      ...raw,
      manual: (raw.manual as unknown) ?? { procedures: {}, assets: {} }, // 既存 manual は温存
    }),
  },
];
```

- [ ] **Step 7: container の traversal ガードを追加**（`persistence/container.ts` の `deserializeContainer` の assets 抽出ループ）:

```ts
for (const [path, data] of Object.entries(files)) {
  if (!path.startsWith(ASSETS_DIR) || path.length <= ASSETS_DIR.length || path.endsWith('/')) continue;
  const name = path.slice(ASSETS_DIR.length);
  // path traversal 予防: 親参照(..)・絶対パス・空セグメント(//)・ドライブレターは無視する
  if (name.includes('..') || name.startsWith('/') || name.includes('//') || /^[a-zA-Z]:/.test(name)) continue;
  assets[name] = data;
}
```

- [ ] **Step 8: 全 Project リテラル構築点に `manual` を追加** — `manual: { procedures: {}, assets: {} }` を:
  `sample.ts` の `finish` 直前の Project リテラル ／ `templates.ts` builder `finish` の Project リテラル ／ `importCsv.ts:107` の Project リテラル ／ `test/helpers.ts` `emptyProject`（**併せて `schemaVersion: 1` → `2`**）／ `store.ts` `initialProject` ／ `session.ts`（MCP）`emptyProject`。
  `scenarioFlow.ts:36` は `{ ...project, ... }` スプレッドなので変更不要（manual 温存）。

- [ ] **Step 9: 型チェック掃引** — `npm run typecheck -w @gantt-flow/core` を回し、残る Project リテラルの型エラーをすべて `manual` 追加で潰す（コンパイラが列挙する）。desktop/mcp のリテラルも同様に潰し、後続タスクが compile 済みの土台から始められるようにする（フル typecheck は Task 7 だが、ここで desktop/mcp の当該リテラルだけは直す）。

- [ ] **Step 10: テスト・型チェック**
  - `npm test -w @gantt-flow/core` → 全緑（既存＋新規）
  - `npm run typecheck -w @gantt-flow/core` → クリーン

- [ ] **Step 11: コミット**

```bash
git add packages/core/src/model/types.ts packages/core/src/model/schema.ts \
  packages/core/src/persistence/migrate.ts packages/core/src/persistence/container.ts \
  packages/core/src/sample.ts packages/core/src/templates.ts packages/core/src/import/importCsv.ts \
  packages/core/test/helpers.ts packages/core/test/persistence.test.ts packages/core/test/container.test.ts \
  apps/desktop/src/store.ts apps/mcp-server/src/session.ts
git commit -m "feat(core): manual 層の型・Zod・v2 マイグレーション追加 (schemaVersion 2 / container traversal ガード)"
```

---

### Task 2 — core コマンド群・validate・deriveProcedureNav

**Files:**
- Create: `packages/core/src/commands/manual.ts`
- Modify: `packages/core/src/commands/index.ts`（`deleteTask`/`deleteTaskKeepChildren` の手順書掃除 ＋ `export * from './manual'`）
- Create: `packages/core/src/sync/procedureNav.ts`
- Modify: `packages/core/src/index.ts`（`export * from './sync/procedureNav'` を sync 群の並びへ追加）
- Modify: `packages/core/src/validate.ts`（warning 3 ルール）
- Create: `packages/core/test/manual-commands.test.ts` / `procedureNav.test.ts` / `validate-procedure.test.ts`

**Interfaces（Consumes）:** `Project`/`Core`/`Manual`/`ProcedureDoc`/`ProcedureStep`/`StepCond`/`StepRef`/`StepImage`/`AssetLocator`/`Id`（`model/types`）、`IdGen`（`ids`）、`isMilestone`（`milestone`）。

**Interfaces（Produces — 正確なシグネチャ）:**

```ts
// commands/manual.ts — すべて clone(structuredClone) 済みの新 project を返す純関数。
// manual のみ更新（core/details/flow は触らない）。`now` は ISO 文字列（updatedAt 用・呼び出し側が注入）。

// --- ProcedureDoc レベル ---
export function upsertProcedure(p: Project, taskId: Id, patch: { purpose?: string }, now: string): Project;
export function deleteProcedure(p: Project, taskId: Id): Project;
export function addProcedureRevision(p: Project, taskId: Id, rev: { note?: string; by?: string }, now: string): Project;

// --- Step ---
export function addStep(p: Project, taskId: Id, args: { action: string; why?: string; bodyMd?: string; id?: Id; atIndex?: number }, idGen: IdGen, now: string): Project;
export function updateStep(p: Project, taskId: Id, stepId: Id, patch: { action?: string; why?: string; bodyMd?: string }, now: string): Project;
export function removeStep(p: Project, taskId: Id, stepId: Id, now: string): Project;
export function moveStep(p: Project, taskId: Id, stepId: Id, toIndex: number, now: string): Project;

// --- StepCond ---
export function addStepCond(p: Project, taskId: Id, stepId: Id, args: { when: string; thenMd: string; targetTaskId?: Id; id?: Id }, idGen: IdGen, now: string): Project;
export function updateStepCond(p: Project, taskId: Id, stepId: Id, condId: Id, patch: { when?: string; thenMd?: string; targetTaskId?: Id }, now: string): Project;
export function removeStepCond(p: Project, taskId: Id, stepId: Id, condId: Id, now: string): Project;

// --- StepRef（StepRef は id を持たないので index で削除） ---
export function addStepRef(p: Project, taskId: Id, stepId: Id, ref: StepRef, now: string): Project;
export function removeStepRef(p: Project, taskId: Id, stepId: Id, index: number, now: string): Project;

// --- StepImage ---
export function addStepImage(p: Project, taskId: Id, stepId: Id, img: { file: string; caption?: string; id?: Id }, idGen: IdGen, now: string): Project;
export function updateStepImage(p: Project, taskId: Id, stepId: Id, imageId: Id, patch: { caption?: string }, now: string): Project;
export function removeStepImage(p: Project, taskId: Id, stepId: Id, imageId: Id, now: string): Project;

// --- 資料台帳 assets ---
export function upsertAsset(p: Project, args: { id?: Id; name: string; desc?: string; locator?: AssetLocator }, idGen: IdGen): Project;
export function updateAsset(p: Project, assetId: Id, patch: { name?: string; desc?: string; locator?: AssetLocator | undefined }): Project;
export function removeAsset(p: Project, assetId: Id): Project;

// sync/procedureNav.ts
export interface ProcedureNavItem {
  taskId: Id;
  name: string;
  layer: number;         // トポロジ層（0..）。同一 layer = 並行
  parallel: boolean;     // 同一 layer に他工程がある
  hasProcedure: boolean; // manual.procedures[taskId] が存在し steps.length > 0
}
export function deriveProcedureNav(core: Core, midId: Id, manual: Manual): ProcedureNavItem[];
```

**規範的挙動:**
- 各コマンドは冒頭で `structuredClone` し、対象工程/ステップ/条件/資料が実在しなければ **no-op（clone をそのまま返す）**。ensureProcedure ヘルパで `manual.procedures[taskId]` を（`{ taskId, steps: [], updatedAt: '', revisions: [] }` で）確保する。ただし `!core.tasks[taskId]` のときは作成しない。
- 手順書を変更する全コマンドは末尾で `doc.updatedAt = now` を立てる。`updateStep`/`updateStepCond`/`updateAsset` は `updateTaskToBe`（`commands/index.ts:443`）と同じ **キー存在ベースの read-merge-write**（patch に無いキーは保持、値 `undefined` のキーは削除。`purpose`/`why`/`bodyMd`/`targetTaskId` などの optional を空欄クリアできる）。
- `addStepRef` は完全一致の重複を張らない（`kind`＋各 id が同一なら no-op）。
- `deleteProcedure` は `manual.procedures[taskId]` を削除するだけ。
- `commands/index.ts` の **`deleteTask`**（サブツリー削除）は `toRemove` の各 id について `delete next.manual.procedures[id]`、**`deleteTaskKeepChildren`**（対象1件削除）は `delete next.manual.procedures[taskId]` を、既存の task/detail 削除ループに並べて追加する。**`StepCond.targetTaskId` / `StepRef` のダングリングは消さない**（リンク切れ表示＝validate warning に委ねる）。
- **validate.ts に warning 3 ルール追加**（いずれも FATAL でない＝`FATAL_ISSUE_KINDS` に入れない）:
  - `procedure.nonLeaf` — `manual.procedures[taskId]` の工程に子がある（＝末端でない）。ref=taskId。
  - `procedure.danglingTarget` — 生存する `StepCond.targetTaskId` が `core.tasks` に無い。ref=stepId（or condId）。
  - `procedure.danglingAsset` — `StepRef{kind:'asset'}` の `assetId` が `manual.assets` に無い。ref=stepId。
  - `procedures[taskId].taskId` 自体が存在しない孤児 doc は掃除済み前提（deleteTask 掃除）だが、`nonLeaf` の走査で `!tasks[taskId]` はスキップする。
- **`deriveProcedureNav`（決定論）:**
  1. `midId` 配下の**末端工程**（子を持たない task）を、`milestoneGuides.ts:36-45` の walk 雛形で再帰収集。
  2. それら末端の集合内の依存（両端が集合内）で **longest-path のレイヤ Map**（`tidy.ts:61-73` の反復緩和と同じ方式）を作る。
  3. `(layer, task.order, taskId.localeCompare)` の安定ソートで直列化。
  4. `parallel` = 同一 `layer` に 2 件以上いるとき true。
  5. `hasProcedure` = `manual.procedures[taskId]?.steps.length > 0`。
  循環ガードは `visited` Set で（`bands.ts` と同様）。RANK 等は不要。

- [ ] **Step 1: 失敗するコマンドテストを書く**（`test/manual-commands.test.ts`）。`counter()` と固定 `now` を注入し、代表ケースを網羅:

```ts
import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import { addTask, deleteTaskKeepChildren, upsertProcedure, addStep, updateStep, moveStep,
  addStepCond, updateStepCond, addStepRef, removeStepRef, addStepImage, upsertAsset, removeAsset } from '../src/commands';

const NOW = '2026-07-05T00:00:00.000Z';

function withLeaf() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: '注文確認', level: 'medium', id: 't1' }, g);
  return { p, g };
}

it('upsertProcedure は doc を作り purpose/updatedAt を立てる', () => {
  const { p, g } = withLeaf();
  const out = upsertProcedure(p, 't1', { purpose: '不備を潰す' }, NOW);
  expect(out.manual.procedures.t1).toEqual({ taskId: 't1', purpose: '不備を潰す', steps: [], updatedAt: NOW, revisions: [] });
});

it('addStep は決定論 id・末尾追加・updatedAt', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '突合する', why: '誤りを潰す' }, g, NOW);
  const step = out.manual.procedures.t1.steps[0];
  expect(step.action).toBe('突合する');
  expect(step.conds).toEqual([]); expect(step.refs).toEqual([]); expect(step.images).toEqual([]);
});

it('cond の飛び先 targetTaskId を保持し、clear もできる', () => { /* addStepCond→updateStepCond({ targetTaskId: undefined }) で消える */ });
it('addStepRef は完全一致重複を張らない', () => { /* 同一 asset ref 2 回で 1 件 */ });
it('工程削除で手順書も掃除される（deleteTaskKeepChildren）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', { purpose: 'x' }, NOW);
  out = deleteTaskKeepChildren(out, 't1');
  expect(out.manual.procedures.t1).toBeUndefined();
});
it('cond の targetTaskId ダングリングは削除で消さない（リンク切れ表示に委ねる）', () => { /* 飛び先工程を消しても cond は残る */ });
it('upsertAsset/removeAsset は台帳を出し入れする', () => { /* id 注入・locator alias/url */ });
```

- [ ] **Step 2: 失敗する procedureNav テストを書く**（`test/procedureNav.test.ts`・ゴールデン）:

```ts
it('末端工程を依存＋order で直列化し、並行を ∥ フラグにする', () => {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: '中', level: 'medium', id: 'M', order: 0 }, g);
  p = addTask(p, { name: 'A', level: 'small', parentId: 'M', id: 'A', order: 0 }, g);
  p = addTask(p, { name: 'B', level: 'small', parentId: 'M', id: 'B', order: 1 }, g);
  p = addTask(p, { name: 'C', level: 'small', parentId: 'M', id: 'C', order: 2 }, g);
  p = addDependency(p, 'A', 'B', g); // A→B、C は独立（A と並行）
  const nav = deriveProcedureNav(p.core, 'M', p.manual);
  expect(nav.map((n) => [n.taskId, n.layer, n.parallel])).toEqual([
    ['A', 0, true], ['C', 0, true], ['B', 1, false],
  ]);
});
```

- [ ] **Step 3: 失敗する validate テストを書く**（`test/validate-procedure.test.ts`）— nonLeaf / danglingTarget / danglingAsset が各 warning を出し、**`deserializeProject` が strict でも読める（FATAL でない）**ことを assert。

- [ ] **Step 4: テストが落ちることを確認** — `npm test -w @gantt-flow/core -- manual procedureNav validate-procedure` → FAIL

- [ ] **Step 5: `commands/manual.ts` を実装**（ヘルパ ＋ 全コマンド）:

```ts
import type { Project, Id, Manual, ProcedureDoc, ProcedureStep, StepCond, StepRef, StepImage, AssetLocator } from '../model/types';
import type { IdGen } from '../ids';

const clone = <T>(x: T): T => structuredClone(x);

function ensureProc(p: Project, taskId: Id): ProcedureDoc | null {
  if (!p.core.tasks[taskId]) return null;
  let d = p.manual.procedures[taskId];
  if (!d) { d = { taskId, steps: [], updatedAt: '', revisions: [] }; p.manual.procedures[taskId] = d; }
  return d;
}
const findStep = (d: ProcedureDoc, stepId: Id) => d.steps.find((s) => s.id === stepId);
// キー存在ベース read-merge-write（updateTaskToBe と同じ規約: undefined 値は当該キー削除）。
function mergePatch<T extends object>(target: T, patch: Partial<Record<keyof T, unknown>>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (target as Record<string, unknown>)[k];
    else (target as Record<string, unknown>)[k] = v;
  }
}

export function upsertProcedure(p: Project, taskId: Id, patch: { purpose?: string }, now: string): Project {
  const next = clone(p); const d = ensureProc(next, taskId); if (!d) return next;
  if ('purpose' in patch) { if (patch.purpose === undefined || patch.purpose === '') delete d.purpose; else d.purpose = patch.purpose; }
  d.updatedAt = now; return next;
}
export function deleteProcedure(p: Project, taskId: Id): Project {
  const next = clone(p); delete next.manual.procedures[taskId]; return next;
}
export function addProcedureRevision(p: Project, taskId: Id, rev: { note?: string; by?: string }, now: string): Project {
  const next = clone(p); const d = ensureProc(next, taskId); if (!d) return next;
  d.revisions.push({ at: now, ...(rev.note ? { note: rev.note } : {}), ...(rev.by ? { by: rev.by } : {}) });
  d.updatedAt = now; return next;
}

export function addStep(p: Project, taskId: Id, args: { action: string; why?: string; bodyMd?: string; id?: Id; atIndex?: number }, idGen: IdGen, now: string): Project {
  const next = clone(p); const d = ensureProc(next, taskId); if (!d) return next;
  const step: ProcedureStep = { id: args.id ?? idGen(), action: args.action,
    ...(args.why ? { why: args.why } : {}), ...(args.bodyMd ? { bodyMd: args.bodyMd } : {}),
    conds: [], refs: [], images: [] };
  const at = args.atIndex ?? d.steps.length; d.steps.splice(Math.max(0, Math.min(d.steps.length, at)), 0, step);
  d.updatedAt = now; return next;
}
export function updateStep(p: Project, taskId: Id, stepId: Id, patch: { action?: string; why?: string; bodyMd?: string }, now: string): Project {
  const next = clone(p); const d = next.manual.procedures[taskId]; const s = d && findStep(d, stepId); if (!d || !s) return next;
  mergePatch(s, patch); d.updatedAt = now; return next;
}
export function removeStep(p: Project, taskId: Id, stepId: Id, now: string): Project {
  const next = clone(p); const d = next.manual.procedures[taskId]; if (!d) return next;
  d.steps = d.steps.filter((s) => s.id !== stepId); d.updatedAt = now; return next;
}
export function moveStep(p: Project, taskId: Id, stepId: Id, toIndex: number, now: string): Project {
  const next = clone(p); const d = next.manual.procedures[taskId]; if (!d) return next;
  const from = d.steps.findIndex((s) => s.id === stepId); if (from < 0) return next;
  const to = Math.max(0, Math.min(d.steps.length - 1, toIndex)); if (to === from) return next;
  const [m] = d.steps.splice(from, 1); d.steps.splice(to, 0, m!); d.updatedAt = now; return next;
}
// addStepCond / updateStepCond / removeStepCond: step.conds を上と同じ流儀で操作（cond.id は idGen or args.id）。
// addStepRef: 完全一致（JSON.stringify 比較で可）を除いて push。removeStepRef: index で splice。
// addStepImage / updateStepImage / removeStepImage: step.images を操作（image.id は idGen or args.id）。
// upsertAsset: id=args.id ?? idGen()。既存なら merge、無ければ新規 { id, name, desc?, locator? }。
// updateAsset: mergePatch。removeAsset: delete next.manual.assets[assetId]。
```
（`addStepCond` 以降も同じ構造で全実装すること。`updateStepCond` は `mergePatch` で `targetTaskId: undefined` によるリンク解除に対応。）

- [ ] **Step 6: `commands/index.ts` を編集**
  - `deleteTask` の「タスク本体と詳細を除去」ループ（`index.ts:257-260`）に `delete next.manual.procedures[id];` を追加。
  - `deleteTaskKeepChildren` の末尾（`index.ts:326-327`、`delete next.details[taskId]` の隣）に `delete next.manual.procedures[taskId];` を追加。
  - ファイル末尾に `export * from './manual';` を追加。

- [ ] **Step 7: `sync/procedureNav.ts` を実装**（上記規範どおり。walk は `milestoneGuides.ts:36-45`、レイヤ緩和は `tidy.ts:61-73` を参考に）。`index.ts` の sync 群へ `export * from './sync/procedureNav';` を追加。

- [ ] **Step 8: `validate.ts` に 3 ルール追加**（`return issues;` の直前）。すべて `issues.push({ kind, ref, message })`。`FATAL_ISSUE_KINDS`（`json.ts:62`）には**足さない**。

- [ ] **Step 9: 緑・型チェック**
  - `npm test -w @gantt-flow/core` → 全緑
  - `npm run typecheck -w @gantt-flow/core` → クリーン

- [ ] **Step 10: コミット**

```bash
git add packages/core/src/commands/manual.ts packages/core/src/commands/index.ts \
  packages/core/src/sync/procedureNav.ts packages/core/src/index.ts packages/core/src/validate.ts \
  packages/core/test/manual-commands.test.ts packages/core/test/procedureNav.test.ts packages/core/test/validate-procedure.test.ts
git commit -m "feat(core): 手順書コマンド群・validate 3ルール・deriveProcedureNav を追加"
```

---

### Task 3 — MCP（get/upsert procedure・upsert_asset・BatchOp・format・fileio fsync）

**依存:** Task 2 完了後。Task 4 と並列可。

**Files:**
- Modify: `apps/mcp-server/src/tools.ts`（3 ツール ＋ `BatchOpSchema` 拡張）
- Modify: `apps/mcp-server/src/batch.ts`（BatchOp 追加）
- Modify: `apps/mcp-server/src/format.ts`（`formatProcedure`）
- Modify: `apps/mcp-server/src/fileio.ts`（`saveProjectFile` を fsync 化）
- Modify: `apps/mcp-server/test/session.test.ts`（fsync round-trip）／ Create: `apps/mcp-server/test/procedure.test.ts`

**Interfaces（Consumes）:** Task 2 の `upsertProcedure`/`addStep`/`upsertAsset`（`@gantt-flow/core`）、`Workspace`/`ProjectSession`（`session.ts`）、`run`/`text`/`fail`/`requireTask`（`tools.ts`）。

**Interfaces（Produces）:**
- Tool `get_procedure` `{ taskId: string }` → `formatProcedure(project, taskId)`（read-only、`ws.current()`）。
- Tool `upsert_procedure` `{ taskId, purpose?, steps?: { action, why?, bodyMd? }[] }`：`purpose` を設定し、`steps` が来たら**全ステップを置換**（各 step は新規 `uuid()` id・conds/refs/images 空）。`ws.current().apply((p) => …)` で write-through。`now = new Date().toISOString()` を注入。
- Tool `upsert_asset` `{ id?, name, desc?, alias?, relPath?, url? }`：`locator` は `alias`+`relPath` があれば `{ alias, relPath }`、`url` があれば `{ url }`、どちらも無ければ未設定。`upsertAsset` を apply。
- `formatProcedure(project: Project, taskId: Id): string`（プレーンテキスト：目的・各ステップの action/why/bodyMd・conds（when→then・飛び先 taskId）・refs・images、未作成なら「手順書は未作成です」）。
- BatchOp 追加（`batch.ts` の `BatchOp` union ＋ `runBatch` switch ＋ `tools.ts` の `BatchOpSchema`）:
  - `{ op: 'set_procedure'; task: string; purpose?: string }`
  - `{ op: 'add_step'; task: string; action: string; why?: string; bodyMd?: string }`
  - `{ op: 'upsert_asset'; ref?: string; id?: string; name: string; desc?: string; alias?: string; relPath?: string; url?: string }`
  `runBatch` は `set_procedure`→`upsertProcedure(p, requireTaskRef(task), { purpose }, now)`、`add_step`→`addStep(p, requireTaskRef(task), {...}, uuid, now)`、`upsert_asset`→`upsertAsset(p, {...}, uuid)`。`now` は `runBatch` 内で 1 度 `new Date().toISOString()` を作り共有。`created` に `steps`/`assets` カウンタを足す。
- `loadProjectFile`/`saveProjectFile` のシグネチャは**不変**（session.ts 無修正）。**assets の配線は Task 6**（本タスクでは触らない）。

**規範的挙動:**
- `saveProjectFile` の `writeFile(tmp, bytes)` を **FileHandle 経由の open→write→sync→close** に置換（電源断でも tmp が中途半端に残らないよう fsync してから rename）。tmp 命名・rename・失敗時 unlink は現行のまま:

```ts
import { open, rename, unlink } from 'node:fs/promises';
// ...
const fh = await open(tmp, 'w');
try { await fh.write(bytes); await fh.sync(); } finally { await fh.close(); }
try { await rename(tmp, path); }
catch (err) { await unlink(tmp).catch(() => undefined); throw err; }
```

- [ ] **Step 1: 失敗するテストを書く**（`test/procedure.test.ts`）: 一時ファイルに新規作成 → `upsert_procedure`（purpose+steps 2件）→ `get_procedure` が両ステップを含む → `reload`（`ProjectSession.open`）で手順書が deep-equal。`upsert_asset` → 台帳に載る。`apply_batch` に `add_step` を混ぜて 1 往復で反映。
- [ ] **Step 2: fsync round-trip テスト**（`session.test.ts` に追記）: 保存後にファイル先頭 2 バイトが `PK`、再読込で deep-equal（fsync 化しても保存互換が壊れないことの回帰）。
- [ ] **Step 3: 落ちることを確認** — `npm test -w @gantt-flow/mcp -- procedure session` → FAIL
- [ ] **Step 4: 実装**（`fileio.ts` fsync ／ `format.ts` `formatProcedure` ／ `batch.ts` op 追加 ／ `tools.ts` の `BatchOpSchema` ＋ 3 ツール登録。ツール登録は `update_task_detail`（`tools.ts:793`）のパターンに厳密に合わせる）。
- [ ] **Step 5: テスト・ビルド**
  - `npm test -w @gantt-flow/mcp` → 全緑（既存 write-through 含む）
  - `npm run build -w @gantt-flow/mcp` → 成功
- [ ] **Step 6: コミット**

```bash
git add apps/mcp-server/src/tools.ts apps/mcp-server/src/batch.ts apps/mcp-server/src/format.ts \
  apps/mcp-server/src/fileio.ts apps/mcp-server/test/session.test.ts apps/mcp-server/test/procedure.test.ts
git commit -m "feat(mcp): 手順書/資料台帳ツール・BatchOp・fileio fsync を追加"
```

---

### Task 4 — 手順書タブ UI 本体（ProcedureView）

**依存:** Task 2 完了後。Task 3 と並列可。**モック `design_reference/procedure-mock.html` が正。** 実装者は opus/sonnet。コード全文は書かず、以下の状態・アクション・規範挙動・モック対応表・セルフチェックに従う。

**Files:**
- Create: `apps/desktop/src/ProcedureView.tsx`
- Create: `apps/desktop/src/markdownLite.tsx`
- Modify: `apps/desktop/src/ui/useUI.ts`（`mainView` ＋ 手順書ローカル表示状態）
- Modify: `apps/desktop/src/store.ts`（手順書 store アクション）
- Modify: `apps/desktop/src/dualwindow.ts`（`ACTION_CLASS` へ新アクション追加）
- Modify: `apps/desktop/src/App.tsx`（タブ ＋ `mainView` 描画分岐）
- Modify: `apps/desktop/src/keymap.ts`（`g p`）＋ `apps/desktop/src/ui/useGlobalHotkeys.ts`（`view.procedure` case）
- Modify: `apps/desktop/src/ui/CommandPalette.tsx`（手順書コマンド）
- Modify: `apps/desktop/src/styles.css`（`.proc-*` / `.procedure-*`）

**Interfaces（useUI に追加）:**

```ts
mainView: 'work' | 'procedure';        // 直交ビュー（分割/表/フローの外側の全面ビュー）。既定 'work'。
setMainView: (v: 'work' | 'procedure') => void;
// 手順書タブが開く中工程（null=選択工程から導出）。クリックジャンプ・パンくず用。
procedureMidId: Id | null;
setProcedureMidId: (id: Id | null) => void;
```
`mainView`/`procedureMidId` は **UI ストア（undo 非対象・非永続でよい）**。`gf-ws-prefs`（App.tsx:185）への保存は任意（今回は不要）。

**Interfaces（store に追加・すべて `ACTION_CLASS='forward'`。`commit` 経由で 1 undo 単位。`now = new Date().toISOString()` を各コマンドへ注入）:**

```ts
upsertProcedurePurpose: (taskId: Id, purpose: string) => void;
addStep: (taskId: Id, args: { action: string; why?: string; bodyMd?: string }) => Id | undefined; // 事前 uuid を args.id に渡して返す
updateStep: (taskId: Id, stepId: Id, patch: { action?: string; why?: string; bodyMd?: string }) => void;
removeStep: (taskId: Id, stepId: Id) => void;
moveStep: (taskId: Id, stepId: Id, toIndex: number) => void;
addStepCond: (taskId: Id, stepId: Id, args: { when: string; thenMd: string; targetTaskId?: Id }) => Id | undefined;
updateStepCond: (taskId: Id, stepId: Id, condId: Id, patch: { when?: string; thenMd?: string; targetTaskId?: Id }) => void;
removeStepCond: (taskId: Id, stepId: Id, condId: Id) => void;
addStepRef: (taskId: Id, stepId: Id, ref: StepRef) => void;
removeStepRef: (taskId: Id, stepId: Id, index: number) => void;
```
（`upsertAsset`/`removeAsset`/`updateAsset` は Task 5、画像 3 アクションは Task 6 で追加。）
実装は既存の別名インポート（`store.ts:43-66`）＋ `commit(coreCmd(get().project, …), 'ラベル')` パターン（例 `updateDetail`, `store.ts:1008`）。作成系（`addStep`/`addStepCond`）は `uuid()` を先に発番し `args.id` に渡して返す（`addRootTask` の規約）。**`dualwindow.ts` の `ACTION_CLASS` に上記全アクションを `'forward'` で追加すること**（`dualwindow.test.ts` が未分類を検出）。作成系を FOCUS_INTENT に足す必要はない（その場リネームはフロー/表専用の導線）。

**規範的挙動（モック対応表）:**

| モック要素 | 実装 |
|---|---|
| topbar タブ「表 / フロー / 手順書」（callout 1） | 手順書タブ＝`setMainView('procedure')`。`work` 時は既存 `PaneLayoutTabs`（分割/表/フロー）を表示、`procedure` 時は手順書を全面表示。手順書タブは常設ボタンとして `PaneLayoutTabs` の隣に置く |
| サイドバー「工程フロー」縦フローナビ（callout 7） | `deriveProcedureNav(project.core, midId, project.manual)` の結果を箱＋矢印（`.mflow`/`.mnode`/`.mlink`）で描画。`parallel` は `∥並行` バッジ |
| 「いまここ」バッジ（`.mnode.here`） | 本文スクロールで可視上端に来た章の taskId を IntersectionObserver 等で追跡し、対応ノードに付与（スクロール追従） |
| ノードのクリックジャンプ | クリックで本文の該当章へ `scrollIntoView`。`setProcedureMidId` で中工程を切替える場合はナビも更新 |
| 作成済み率「4/6」（callout 4、`.covbar`/`.cov`） | nav の `hasProcedure` を数えて `作成済み/総数`。ノードごとに `✓`（作成済み）/`—`（未作成） |
| パンくず・見出し（`.crumb`/`.doc-h`/`.purpose`） | 中工程の祖先パス＋名称、`purpose` は `upsertProcedurePurpose` で編集（onBlur コミット） |
| 章見出し（`.chap-h`：名称・担当・工数・「フローで表示 →」） | 担当/工数は details から表示（**編集しない＝一行サマリは既存フィールド**）。「フローで表示」＝`useApp.select(taskId)`＋`useUI.setMainView('work')`＋`setPaneLayout('flow')` |
| 章直下「目的（how の一行サマリ）」（`.chap-purpose`） | **`TaskDetail.how` を同一フィールドとして表示・編集**（`updateDetail(taskId,{how})`・二重管理しない） |
| ステップ（`.step`：action 太字／why／detail 本文） | `action`＝太字（`updateStep action`）、`why`＝「目的:」（`updateStep why`）、`detail`＝`bodyMd` を **`markdownLite` でレンダリング**、編集は textarea（`updateStep bodyMd`・onBlur コミット） |
| 条件ボックス（`.cond`：「〜の場合」＋対処＋飛び先リンク・callout 3） | `when`/`thenMd` を編集。飛び先は `<select className="dep-add">` で全工程候補（`nameOf`）。選択＝`updateStepCond targetTaskId`、空選択＝クリア。飛び先クリックで該当工程の手順書へジャンプ |
| 参照チップ（`.chips`：io/asset・callout 2） | `StepRef` をチップ表示。`io`＝該当帳票名、`asset`＝台帳名（Task 5 のピッカーで追加）。**ダングリングは `.chip.broken`（リンク切れ）表示**（validate warning と一致） |
| 画像（`.shot`・callout 8） | Task 6（本タスクでは席のみ・描画分岐を用意） |
| 前後工程リンク（`.entry`：▲前 / ▼次） | 中工程をまたぐ導線。ナビの直列順の先頭前・末尾後の工程へリンク |
| 未作成プレースホルダ（`.empty-proc`：「＋手順を書く」/「✨ドラフト生成」） | 「＋手順を書く」＝`upsertProcedurePurpose(taskId,'')`＋最初のステップ追加。「✨ドラフト生成」は**AI サイクル用に disabled 表示**（本サイクルは非活性） |

**`markdownLite.tsx`（正確な仕様）:** `export function MarkdownLite({ text }: { text: string }): JSX.Element` — 段落（空行区切り）・箇条書き（`- `）・番号付き（`1. `）・`**太字**`・行内 `` `コード` ``・改行（行末）だけを **React 要素**として組む。`dangerouslySetInnerHTML` は使わない。未知記法はプレーンテキストとして出す。ユニットテスト（`apps/desktop/test/markdownLite.test.tsx`）で各記法の要素化を確認。

**App.tsx 描画分岐:** `mainView === 'procedure'` のとき `<ProcedureView />` を `.panes` の代わりに全面描画。`work` のときは現行の `.panes`。`StatusBar` は共通。フォロワー窓（`isFollower`）でも手順書は編集可（forward される）。

**キー/パレット:** `keymap.ts` に `{ id: 'go-procedure', action: 'view.procedure', context: 'global', chord: { key: 'p' }, leader: true, lowRisk: true, help: { group: G.nav, label: '手順書タブへ' } }` を追加（`g p`）。`useGlobalHotkeys.ts` に `case 'view.procedure': useUI.getState().setMainView('procedure'); return true;` を追加。`g d`/`g t`/`g f`（`layout.*`/`pane.*`）実行時は `setMainView('work')` も併せて呼ぶ（手順書から作業ビューへ戻す）。`CommandPalette.tsx` の layout コマンド群（:777 付近）に「手順書」コマンド（`run: () => ui.setMainView('procedure')`）を 1 件追加。

**UI セルフチェック（完了条件・実装者が puppeteer-core / claude-in-chrome で確認しスクショ添付）:**
- [ ] `g p` とタブで手順書に入り、`g d` で作業ビューに戻る
- [ ] purpose / action / why / bodyMd を編集 → **onBlur でコミット**、Escape で編集キャンセル（`inputBehaviors.ts` の `cancelEditOnEscape` を流用）
- [ ] ステップ選択中の Delete がステップ削除に効き、**未選択時にグローバル暴発しない**
- [ ] ナビのノードクリックで本文がジャンプ、スクロールで「いまここ」が追従
- [ ] 条件の飛び先 select が全工程を出し、選択でリンク・クリックでジャンプ
- [ ] 未作成工程でプレースホルダが出る／作成で率（4/6）が更新
- [ ] `bodyMd` に `**太字**`・箇条書きを入れて `markdownLite` が要素化（`<script>` を書いても実行されない＝XSS 安全）
- [ ] ダーク/ライト両テーマで崩れない（`styles.css` トークン準拠）

- [ ] **Step 1: `markdownLite.tsx` を TDD で実装**（`test/markdownLite.test.tsx` → 実装 → 緑）
- [ ] **Step 2: `useUI` に `mainView`/`procedureMidId` を追加**
- [ ] **Step 3: store に手順書アクションを追加し、`ACTION_CLASS` へ登録**（`npm test -w @gantt-flow/desktop -- dualwindow` が緑になること）
- [ ] **Step 4: `ProcedureView.tsx` を実装**（モック対応表どおり）＋ `styles.css` に `.proc-*`
- [ ] **Step 5: App.tsx タブ＋分岐、keymap/hotkey/palette を配線**
- [ ] **Step 6: desktop テスト・型チェック** — `npm test -w @gantt-flow/desktop` / `npm run typecheck -w @gantt-flow/desktop` → 緑
- [ ] **Step 7: 実画面セルフチェック（上記リスト）＋スクリーンショット**
- [ ] **Step 8: コミット**

```bash
git add apps/desktop/src/ProcedureView.tsx apps/desktop/src/markdownLite.tsx apps/desktop/test/markdownLite.test.tsx \
  apps/desktop/src/ui/useUI.ts apps/desktop/src/store.ts apps/desktop/src/dualwindow.ts apps/desktop/src/App.tsx \
  apps/desktop/src/keymap.ts apps/desktop/src/ui/useGlobalHotkeys.ts apps/desktop/src/ui/CommandPalette.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): 手順書タブ本体 (ProcedureView・縦フローナビ・markdownLite・g p) を追加"
```

---

### Task 5 — 資料台帳 ＋ 場所エイリアス

**依存:** Task 4 完了後。

**Files:**
- Create: `apps/desktop/src/AssetLedger.tsx`（台帳ドロワー）
- Create: `apps/desktop/src/locationAliases.ts`（`gf-location-aliases-v1`）
- Modify: `apps/desktop/src/store.ts`（`upsertAsset`/`updateAsset`/`removeAsset` アクション）
- Modify: `apps/desktop/src/dualwindow.ts`（`ACTION_CLASS` 追加）
- Modify: `apps/desktop/src/ProcedureView.tsx`（台帳を開くボタン／ステップからの参照ピッカー）
- Modify: `apps/desktop/src/styles.css`（`.drawer`/`.asset`）

**Interfaces（`locationAliases.ts`）:**

```ts
// alias → 実フォルダ絶対パスの対応表（各 PC ローカル・.gflow には保存しない）。keymap.ts:456-475 の try/catch 雛形。
export function loadLocationAliases(): Record<string, string>;   // { [alias]: absPath }
export function saveLocationAliases(map: Record<string, string>): void;
export function resolveLocator(locator: AssetLocator | undefined, aliases: Record<string, string>): {
  state: 'resolved' | 'disconnected' | 'url';
  display: string;   // resolved=結合した実パス / disconnected="alias/relPath" 表記 / url=URL
} ;
```

**Interfaces（store・すべて `ACTION_CLASS='forward'`）:**
```ts
upsertAsset: (args: { id?: Id; name: string; desc?: string; locator?: AssetLocator }) => Id | undefined;
updateAsset: (assetId: Id, patch: { name?: string; desc?: string; locator?: AssetLocator }) => void;
removeAsset: (assetId: Id) => void;
```
`upsertAsset` は事前 `uuid()` を `args.id` に渡して返す。`ACTION_CLASS` へ 3 件追加。

**規範的挙動（モック対応表・callout 4）:**
- 台帳ドロワー（`.drawer`：`資料台帳` 見出し＋資産カード＋「＋資料を追加」）。カードは名称・パス・「使用: N工程・Mステップ」（`manual` 全 `StepRef{kind:'asset'}` を数えて逆引き）。
- **リンク状態は本サイクルでは 2 表示に集約**（`resolveLocator` の state で分岐）:
  - `resolved`（alias がローカル対応表にある）＝結合実パスを表示＋**「パスをコピー」ボタン**（クリップボードへコピー。フォルダを開く機能は将来）。
  - `disconnected`（対応表に無い＝コンサル環境の常態）＝グレー表示で `alias/relPath` 表記のまま（**エラー扱いしない・検査対象外**）。
  - `url` はそのまま表示（コピー可）。
  - **リンク実在検査（真のリンク切れ）は将来サイクル**（Rust の fs 検査が要るため対象外）。`.asset.err`（`.warn`）は **validate の `procedure.danglingAsset`（台帳から資料が削除され StepRef が孤児化）にのみ**用いる。
- 資料の追加/編集フォーム：名称・説明・`locator`（`alias`＋`relPath` か `url` の択一）。`alias` はテキスト入力（自由入力＝新規 alias もそのまま持てる）。対応表の登録は別 UI（設定 or 台帳内の小フォーム）で `saveLocationAliases`。
- ステップからの参照ピッカー：`.chip` の「＋参照」から台帳の資産一覧を選び `addStepRef({ kind: 'asset', assetId })`。io 参照（`{ kind: 'io', taskId, ioId }`）は当該工程の入出力から選ぶ。

**UI セルフチェック（実画面・スクショ）:**
- [ ] 資料を追加→カード表示、名称/パス編集が onBlur コミット、削除でカード消滅
- [ ] alias 未登録＝グレー表記、対応表登録後＝実パス＋「パスをコピー」でクリップボードに入る
- [ ] ステップから資料を参照→チップ表示、台帳から資料削除→チップが `.chip.broken`（validate warning と一致）
- [ ] 逆引き「使用: N工程」が実データと一致

- [ ] **Step 1: `locationAliases.ts` を TDD**（`resolveLocator` の 3 分岐をユニットテスト）
- [ ] **Step 2: store の asset アクション＋`ACTION_CLASS`（`dualwindow` テスト緑）**
- [ ] **Step 3: `AssetLedger.tsx` ＋ ProcedureView 配線 ＋ styles**
- [ ] **Step 4: desktop テスト/型チェック緑**
- [ ] **Step 5: 実画面セルフチェック＋スクショ**
- [ ] **Step 6: コミット**

```bash
git add apps/desktop/src/AssetLedger.tsx apps/desktop/src/locationAliases.ts apps/desktop/test/locationAliases.test.ts \
  apps/desktop/src/store.ts apps/desktop/src/dualwindow.ts apps/desktop/src/ProcedureView.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): 資料台帳ドロワー・場所エイリアス(パスをコピー)・参照ピッカーを追加"
```

---

### Task 6 — 画像（assetStore メモリ層・貼り付け・保存配線・二窓配布）

**依存:** Task 5 完了後。**最大の落とし穴（画像バイナリは Project 外・undo/autosave に乗らない）に注意。**

**Files:**
- Create: `apps/desktop/src/assetStore.ts`（メモリ層 ＋ blob URL ＋ ハッシュ命名 ＋ GC ＋ 二窓配布）
- Create: `packages/core/src/manualAssets.ts`（`collectReferencedAssetFiles` 純関数）＋ `packages/core/src/index.ts` に export ＋ `packages/core/test/manualAssets.test.ts`
- Modify: `apps/desktop/src/store.ts`（`addStepImage`/`updateStepImage`/`removeStepImage` アクション）
- Modify: `apps/desktop/src/dualwindow.ts`（`ACTION_CLASS` 追加 ＋ `SyncMessage` に `asset` 型 ＋ leader/follower 中継）
- Modify: `apps/desktop/src/persistence.ts`（保存＝参照分の assets を ZIP へ／読込 5 経路で assets を assetStore へ）
- Modify: `apps/mcp-server/src/fileio.ts` ＋ `apps/mcp-server/src/session.ts`（assets を握って書き戻す＝write-through で捨てない）
- Modify: `apps/desktop/src/ProcedureView.tsx`（paste/ファイル選択・blob URL 描画・削除 UI）
- Modify: `apps/desktop/src/styles.css`（`.shot`）

**Interfaces（`manualAssets.ts`・core 純関数）:**
```ts
// project から参照される画像ファイル名（StepImage.file）の集合。保存時 GC と MCP write-through に共用。
export function collectReferencedAssetFiles(project: Project): Set<string>;
```

**Interfaces（`assetStore.ts`）:**
```ts
export function contentHashName(bytes: Uint8Array, mime: string): string; // 内容ハッシュ由来の安定名（例 "<hash>.png"）
export function putAsset(file: string, bytes: Uint8Array): void;          // メモリ Map へ格納（重複は共有）
export function getAssetBytes(file: string): Uint8Array | undefined;
export function getAssetUrl(file: string): string | undefined;           // blob URL（生成をキャッシュ）
export function hasAsset(file: string): boolean;
export function snapshotAssets(files: Iterable<string>): Record<string, Uint8Array>; // 保存用に参照分を抽出
export function ingestAssets(assets: Record<string, Uint8Array>): void;  // open/external-watch で読み込んだ分を投入
export function broadcastAsset(file: string, bytes: Uint8Array): void;   // 二窓へ bytes 配布（下記 SyncMessage 経由）
```
ハッシュは依存追加を避け、`crypto.subtle.digest('SHA-256', …)` か簡易 FNV でよい（**内容が同じなら同名**になれば十分）。blob URL は `URL.createObjectURL` を遅延生成しキャッシュ。

**Interfaces（`store` 画像アクション・`ACTION_CLASS='forward'`）:**
```ts
addStepImage: (taskId: Id, stepId: Id, bytes: Uint8Array, mime: string, caption?: string) => void;
updateStepImage: (taskId: Id, stepId: Id, imageId: Id, patch: { caption?: string }) => void;
removeStepImage: (taskId: Id, stepId: Id, imageId: Id) => void;
```
`addStepImage` の流れ：`file = contentHashName(bytes, mime)` → `putAsset(file, bytes)` → `broadcastAsset(file, bytes)` → `commit(cAddStepImage(project, taskId, stepId, { file, caption }, uuid, now), '画像を追加')`。**Project には `file` だけが入る**（bytes は入れない＝undo/autosave が肥大しない）。`ACTION_CLASS` に 3 件追加。

**二窓配布（`dualwindow.ts`）:**
- `SyncMessage` union に `{ type: 'asset'; file: string; bytes: Uint8Array }` を追加（`SyncChannel` は BroadcastChannel で structured clone → `Uint8Array` を運べる）。
- `broadcastAsset` は当該メッセージを post。leader/follower 双方の `ch.onmessage` に `type === 'asset'` 分岐を足し、受信側は `putAsset(file, bytes)` する（forward の action 転送とは別経路＝画像だけは全窓へ実バイトを配る）。
- 通常の action 転送（`file` を含む Project 差分）は既存どおり snapshot で伝播。**bytes は snapshot に載せない**（重いので別経路）。
- **後から開いた窓への追いつき（必須）**: リーダーは follower の hello（接続確立）を受けたら、現 project が参照する assets（`collectReferencedAssetFiles` ∩ assetStore）を `asset` メッセージで一括再送する（`putAsset` は冪等なので重複無害）。これが無いと後起動のフォロワーで既存画像が全て壊れる。`test/dualwindow.test.ts` に「hello 後に asset 再送が飛ぶ」ケースを追加。

**永続化配線（`persistence.ts`）:**
- 保存（`serializeContainer(project)` at :319）→ `serializeContainer(project, snapshotAssets(collectReferencedAssetFiles(project)))`。**参照分のみ＝保存時 GC**。メモリ（assetStore）は消さない。
- 読込 5 経路（`deserializeContainer(...).project` at :427/:625/:654/:672/:761）→ `const c = deserializeContainer(...); ingestAssets(c.assets); const project = c.project;`。外部変更検知（:625 付近 `pollExternal`）でも同様に `ingestAssets`。
- `autosave.ts`/`backups.ts`（localStorage）は**変更しない**＝画像を含めない。**復旧時は画像欠落を許容**（Task 7 でドキュメント化）。

**MCP write-through（`fileio.ts`＋`session.ts`）:**
- `loadProjectFile` を assets も返すよう拡張（`{ project, assets }`）または `ProjectSession` に `assets` を保持。`saveProjectFile(path, project, assets)` で `serializeContainer(project, pickReferenced(assets))` を書く（`collectReferencedAssetFiles` で GC）。**MCP は画像を生成しないが、既存 assets を write-through で落とさない**のが目的。session.apply / fromProject / create / saveAs の各保存で assets を渡す。

**UI セルフチェック（実画面・スクショ）:**
- [ ] ステップに画像をクリップボード貼り付け（DOM paste）→ 表示、ファイル選択でも追加
- [ ] 保存 → 再オープンで画像が残る（ZIP `assets/` 往復）
- [ ] **保存後に undo しても画像が生きている**（メモリ保持・GC はメモリを消さない）
- [ ] 同一内容の画像を 2 箇所に貼ると同名で共有される
- [ ] 二窓（`?window=edit`）で片方に貼った画像がもう片方にも出る（bytes 配布）
- [ ] 画像削除 → チップ/図が消え、保存時 GC で ZIP からも落ちる
- [ ] b64 多チャンク回帰：>32KB の画像を貼って保存→読込で壊れない（`b64.ts` の CHUNK 境界。desktop persistence テストにケース追加）

- [ ] **Step 1: `manualAssets.ts` を TDD（core）**＋ export
- [ ] **Step 2: `assetStore.ts`（ハッシュ命名・put/get/url・snapshot/ingest）をユニットテスト付きで実装**
- [ ] **Step 3: store 画像アクション＋`ACTION_CLASS`（dualwindow テスト緑）**
- [ ] **Step 4: `dualwindow.ts` に `asset` メッセージ＋中継を追加**（`test/dualwindow.test.ts` に配布テストを足す）
- [ ] **Step 5: `persistence.ts` の保存/読込 6 経路に assets を配線**＋ `test/persistence.test.ts` に >32KB round-trip
- [ ] **Step 6: MCP `fileio.ts`/`session.ts` の assets write-through**＋ mcp テストに「assets を保存で落とさない」ケース
- [ ] **Step 7: ProcedureView に paste/ファイル選択・blob URL 描画・削除 UI・styles**
- [ ] **Step 8: desktop / mcp / core の当該テスト・型チェック緑**（フル workspace は Task 7）
- [ ] **Step 9: 実画面セルフチェック＋スクショ**
- [ ] **Step 10: コミット**

```bash
git add packages/core/src/manualAssets.ts packages/core/src/index.ts packages/core/test/manualAssets.test.ts \
  apps/desktop/src/assetStore.ts apps/desktop/src/store.ts apps/desktop/src/dualwindow.ts apps/desktop/src/persistence.ts \
  apps/desktop/src/ProcedureView.tsx apps/desktop/src/styles.css apps/desktop/test/persistence.test.ts apps/desktop/test/dualwindow.test.ts \
  apps/mcp-server/src/fileio.ts apps/mcp-server/src/session.ts apps/mcp-server/test/session.test.ts
git commit -m "feat: ステップ画像 (assetStore メモリ層・ZIP 保存GC・二窓bytes配布・MCP write-through) を追加"
```

---

### Task 7 — 総合検証・ドキュメント同期

**依存:** Task 6 完了後。

**Files:**
- Modify: `CLAUDE.md`（commands 更新範囲規約の拡張・`manual` セクションの追記・乖離注記の更新）
- Modify: `docs/05-persistence.md`（v2 ZIP コンテナ実装済みの現状同期＝前サイクル繰越）

- [ ] **Step 1: CLAUDE.md を更新**
  - 「破ってはいけない設計ルール」2 の commands 更新範囲を **「`core` / `details` / `manual` のみ・`flow` は触らない」** に拡張。
  - スタック/構成の説明に `project.manual`（手順書・資料台帳）の新設と `deriveProcedureNav`（`bands`/`milestoneGuides` 同型）を追記。
  - 「⚠️ ドキュメントと実装の乖離」の `.gflow` 記述を、v2 ZIP コンテナ実装済み（`packages/core/src/persistence/container.ts`・`project.json`＋`assets/`）に合わせて更新（前サイクル繰越）。localStorage の autosave/backups は画像を含まない旨を明記。
- [ ] **Step 2: docs/05-persistence.md を現状同期**（ZIP バンドルは実装済み・`schemaVersion` 2・manual の追加・マイグレーションはメモリ上のみ）。
- [ ] **Step 3: フルスイープ（本サイクル唯一の全体実行）**
  - `npm test --workspaces` → 全緑
  - `npm run typecheck --workspaces` → クリーン
  - （Rust/Tauri は無変更のため cargo は不要。念のため `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` を回すなら任意）
- [ ] **Step 4: 実ブラウザ probe（要点リスト）** — `npm run dev -w @gantt-flow/desktop` で:
  - 手順書タブ表示（`g p`／タブ）とビュー往復
  - 縦フローナビのスクロール追従（いまここ）とクリックジャンプ
  - purpose/step/cond/ref の編集と onBlur コミット、条件飛び先ジャンプ
  - `markdownLite` の描画（太字・箇条書き・`<script>` が無害）
  - 画像の貼り付け／保存→再オープン→**保存後 undo でも画像が生きる**
  - 資料台帳ドロワー・alias 表示（未接続グレー／パスをコピー）
  - 二窓（`?window=edit`）で手順書編集と画像 bytes 配布
  - 保存→再オープンで手順書・台帳・画像がすべて往復（v2 ZIP）
- [ ] **Step 5: 最終レビュー**
  - **migration-safety-reviewer**（`CURRENT_SCHEMA_VERSION` bump・Zod/型変更・load-save 変更のため必須）
  - **reconcile 不変条件の確認**（reconcile-invariant-reviewer は sync 無変更なら不要だが、`reconcileProject` が manual を温存すること・手順書コマンドが flow を触らないことを diff で確認）
  - opus によるブランチ全体レビュー（`git merge-base` からの review-package）
- [ ] **Step 6: コミット**

```bash
git add CLAUDE.md docs/05-persistence.md
git commit -m "docs: 手順書層(manual)・commands更新範囲規約・.gflow v2 を反映"
```

---

## 付録: 実装者への指示（曖昧さの解消）

- **`now` の注入**：core の手順書コマンドは `updatedAt` のため `now: string` を最終引数（`idGen` の後）に取る。store は `new Date().toISOString()`、MCP は同、テストは固定 `'2026-07-05T00:00:00.000Z'`。この方式で純粋性・決定論を保つ（`meta.updatedAt` を session/store で立てるのと同じ思想）。
- **`manual` は必須**：optional にすると各コマンドで `?? {…}` の防御が散らばるため必須にする。migration が旧ファイルへ確実に付与し、Zod parse 前に走る（`json.ts:77`）ので後方互換は保たれる。
- **`deleteTask` と `deleteTaskKeepChildren` の両方**に手順書掃除を入れる（store の `removeTask`/`removeManyTasks` は後者を使う。前者はサブツリー削除経路の保険）。掃除対象は `manual.procedures` のみ。**cond/ref のダングリングは掃除せずリンク切れ表示**に委ねる。
- **StepRef に id は無い**：削除は index 指定。UI はチップを配列順で描くので index が安定。
- **`view.procedure` と作業ビュー復帰**：`g d`/`g t`/`g f` は `setMainView('work')` を必ず併発すること（手順書に入ったまま分割操作が効かない事故を防ぐ）。
- **ACTION_CLASS 登録漏れは `dualwindow.test.ts` が検出**する。新 store アクションを足すたび同テストを回す。
- **画像は snapshot に載せない**：二窓へは `asset` メッセージで bytes を別配布。`pickSnapshot` は変更しない（重いバイナリを毎編集で配らない）。
