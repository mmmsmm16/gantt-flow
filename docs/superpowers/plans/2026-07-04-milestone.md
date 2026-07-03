# マイルストーン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 業務フロー上部に独立した菱形＋全レーンを貫く縦破線でマイルストーン（節目）を表示し、対象工程（この節目までに終わらせる工程）と紐付けて縦線が自動追従するようにする。

**Architecture:** `ProcessTask.kind?: 'milestone'`（マーカータスク・スキーマ bump 不要）。reconcile 上は通常タスクとして 1:1 ノードを保持しつつ、①導出エッジは生成時に抑制 ②tidy/bands から除外 ③描画は導出関数 `deriveMilestoneGuides`（bands パターン・FlowCanvas と flowSvg で共有）。スペック: `docs/superpowers/specs/2026-07-04-milestone-design.md`（設計検証メモの必須3修正を反映済み）。

**Tech Stack:** 純 TS core（vitest golden）+ React desktop + MCP server。

## Global Constraints

- ブランチ `feature/milestone`（作成済み）。main 直コミット禁止。
- `packages/core` に UI/OS 依存を持ち込まない。ID は `idGen` 注入・テストは `counter()`（`Date.now`/`Math.random` 禁止）。
- reconcile の不変条件（CLAUDE.md）を維持: 1:1 task↔node（**マイルストーンも FlowTaskNode を持つ**）・位置安定・pinned/制御ノード生存・冪等・ダングリングなし。
- マイルストーン判定は必ず共有ヘルパ `isMilestone(core, id)` を使う（判定ロジックの分散禁止）。
- 行番号アンカーはドリフトし得る — **コード内容で位置を特定**する（前サイクルで実証済みの運用）。
- ファイル編集は Write/Edit ツールのみ（PowerShell `Out-File` 禁止）。
- 各タスクは既存テストを緑に保ったままコミットする。

---

### Task 1: core モデル＋コマンドガード＋集計除外（TDD）

**Files:**
- Modify: `packages/core/src/model/types.ts`（ProcessTask に `kind?`）
- Modify: `packages/core/src/model/schema.ts`（Zod に `kind`）
- Create: `packages/core/src/milestone.ts`（`isMilestone` ヘルパ）
- Modify: `packages/core/src/index.ts`（export 追加）
- Modify: `packages/core/src/commands/index.ts`（AddTaskArgs.kind / 各ガード）
- Modify: `packages/core/src/codes.ts`（採番スキップ）
- Modify: `packages/core/src/compare.ts`（leafIds から除外）
- Modify: `packages/core/src/validate.ts`（ルール追加）
- Test: `packages/core/test/milestone.test.ts`（新規）

**Interfaces:**
- Produces: `ProcessTask.kind?: 'milestone'` / `isMilestone(core: Core, id: Id): boolean` /
  `AddTaskArgs.kind?: 'milestone'`（Task 2〜6 が前提にする）

- [ ] **Step 1: 失敗するテストを書く** — `packages/core/test/milestone.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { addTask, addDependency, deleteTask, reparentTask } from '../src/commands';
import { computeCodes } from '../src/codes';
import { isMilestone } from '../src/milestone';
import { counter, emptyProject, taskIdByName } from './helpers';

function base() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: 'A', level: 'medium' }, g);
  p = addTask(p, { name: 'B', level: 'medium' }, g);
  p = addTask(p, { name: '節目', level: 'medium', kind: 'milestone' }, g);
  p = addTask(p, { name: 'C', level: 'medium' }, g);
  return { p, g };
}

describe('milestone core', () => {
  it('addTask kind:milestone → isMilestone が真・通常タスクは偽', () => {
    const { p } = base();
    expect(isMilestone(p.core, taskIdByName(p, '節目'))).toBe(true);
    expect(isMilestone(p.core, taskIdByName(p, 'A'))).toBe(false);
  });

  it('入依存（工程→MS）は張れるが、出依存（MS→工程）は no-op', () => {
    const { p, g } = base();
    const ms = taskIdByName(p, '節目');
    const a = taskIdByName(p, 'A');
    const p2 = addDependency(p, a, ms, g);
    expect(Object.values(p2.core.dependencies).some((d) => d.from === a && d.to === ms)).toBe(true);
    const p3 = addDependency(p2, ms, taskIdByName(p, 'C'), g);
    expect(Object.values(p3.core.dependencies).some((d) => d.from === ms)).toBe(false);
  });

  it('MS を親にする addTask / reparentTask は no-op', () => {
    const { p, g } = base();
    const ms = taskIdByName(p, '節目');
    const before = Object.keys(p.core.tasks).length;
    const p2 = addTask(p, { name: '子', level: 'small', parentId: ms }, g);
    expect(Object.keys(p2.core.tasks).length).toBe(before);
    const p3 = reparentTask(p, taskIdByName(p, 'C'), ms);
    expect(p3.core.tasks[taskIdByName(p, 'C')]!.parentId).not.toBe(ms);
  });

  it('deleteTask のブリッジは MS を経由しない（MS from のブリッジ依存を作らない）', () => {
    const { p, g } = base();
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    const ms = taskIdByName(p, '節目');
    let q = addDependency(p, a, b, g);
    q = addDependency(q, ms, b, g); // no-op（出依存）— ここでは張られない前提の確認込み
    q = addDependency(q, b, ms, g); // B → MS
    q = deleteTask(q, b, g); // B を消してもブリッジで MS→x を作らない
    expect(Object.values(q.core.dependencies).some((d) => d.from === ms)).toBe(false);
  });

  it('computeCodes は MS を採番せず、兄弟の番号も飛ばない', () => {
    const { p } = base();
    const codes = computeCodes(p.core);
    expect(codes[taskIdByName(p, '節目')]).toBeUndefined();
    expect(codes[taskIdByName(p, 'A')]).toBe('1');
    expect(codes[taskIdByName(p, 'B')]).toBe('2');
    expect(codes[taskIdByName(p, 'C')]).toBe('3'); // MS がいても 3（4 にならない）
  });

  it('kind なしの既存データはそのまま Zod を通る（後方互換）', () => {
    const { p } = base();
    delete (p.core.tasks[taskIdByName(p, 'A')] as Record<string, unknown>)['kind'];
    // schema.ts の ProjectSchema でパースできること（実 import はテスト実装時に確認）
  });
});
```

（最後のケースは実装時に `ProjectSchema.parse` の実名に合わせて完成させる。`compare.ts` の
leafCount 除外は既存の compare テストの流儀に合わせ 1 ケース追加する。）

- [ ] **Step 2: 失敗を確認** — `npm test -w @gantt-flow/core -- milestone` → FAIL
- [ ] **Step 3: 実装**

1. `types.ts` の `ProcessTask` に追加（`code?` の隣）:
```ts
  /** 'milestone' = 節目マーカー。子・担当・工数・工程Noを持たず、出依存も張れない。省略時は通常工程。 */
  kind?: 'milestone';
```
2. `schema.ts` の ProcessTask スキーマに `kind: z.literal('milestone').optional(),` を追加。
3. `packages/core/src/milestone.ts`（新規）:
```ts
// マイルストーン判定の単一ヘルパ。ガード・集計・同期・描画のすべてがこれを参照する。
import type { Core, Id } from './model/types';

export function isMilestone(core: Core, id: Id | undefined): boolean {
  return !!id && core.tasks[id]?.kind === 'milestone';
}
```
4. `index.ts` に `export * from './milestone';` を追加。
5. `commands/index.ts`:
   - `AddTaskArgs` に `kind?: 'milestone';` を追加し、`addTask` で
     ①`args.parentId` がマイルストーンなら `return clone(p)`（no-op）
     ②`task` 生成時に `...(args.kind ? { kind: args.kind } : {})` を含める。
   - `addDependency` の存在ガード直後に `if (isMilestone(next.core, from)) return next;` を追加。
   - `reparentTask`: 新親がマイルストーンなら no-op（既存の level-skip ガードと同じ場所）。
   - `deleteTask` / `deleteTaskKeepChildren` のブリッジ依存生成ループで
     `if (isMilestone(next.core, from) ) continue;`（from にマイルストーンが来る組は作らない。
     to 側は入依存として正当なので許可）。生成箇所は `addDependency` を経由していないので必ず両方に入れる。
6. `codes.ts` の `walk` を「マイルストーンをスキップし、インデックスも消費しない」形に:
```ts
  const walk = (parentId: Id | undefined, prefix: string) => {
    let i = 0;
    for (const t of byParent.get(parentId) ?? []) {
      if (t.kind === 'milestone') continue; // 節目は採番せず、番号も飛ばさない
      i += 1;
      const no = t.code ?? (prefix ? `${prefix}-${i}` : `${i}`);
      codes[t.id] = no;
      walk(t.id, no);
    }
  };
```
7. `compare.ts` の leaf 判定（子を持たないタスク集計）に `&& t.kind !== 'milestone'` を追加
   （実コードを読んで leafIds/leafCount の実装に合わせる）。
8. `validate.ts` に検査を追加（既存ルールの流儀に合わせる・重大度は WARN）:
   「マイルストーンが子を持つ」「マイルストーンから出る依存がある」。

- [ ] **Step 4: 通す** — `npm test -w @gantt-flow/core && npm run typecheck -w @gantt-flow/core` → PASS
- [ ] **Step 5: コミット** — `feat(core): ProcessTask.kind='milestone' とガード・採番/集計除外`

---

### Task 2: 導出 `deriveMilestoneGuides`（TDD）

**Files:**
- Create: `packages/core/src/sync/milestoneGuides.ts`
- Modify: `packages/core/src/index.ts`（export）
- Test: `packages/core/test/milestoneGuides.test.ts`

**Interfaces:**
- Consumes: Task 1 の `kind` / `isMilestone`
- Produces: `deriveMilestoneGuides(core, view): MilestoneGuide[]`、
  `interface MilestoneGuide { taskId: Id; label: string; x: number; bound: boolean }`（Task 4 が使用）

- [ ] **Step 1: テスト**（reconcileFlow でビューを作る `phaseStrip` と同じ流儀）:
  ①紐付きMS: guide.x = 対象工程ノードの `x + SIZE.task.w` の最大値 + 40、`bound: true`
  ②未紐付けMS: guide.x = 自ノードの x、`bound: false`
  ③対象工程ノードの x を手動変更 → guide.x が追従
  ④MS が無いビュー → `[]`、決定論ソート（x → taskId）
- [ ] **Step 2: FAIL 確認** → **Step 3: 実装**:

```ts
// マイルストーン縦線の導出（bands パターン・保存しない）。spec: docs/superpowers/specs/2026-07-04-milestone-design.md
import type { Core, FlowLevelView, FlowTaskNode, Id } from '../model/types';
import { SIZE } from './autoPlace';
import { isMilestone } from '../milestone';

export interface MilestoneGuide {
  taskId: Id;
  label: string;
  x: number; // 縦線の x（モデル座標）
  bound: boolean; // 対象工程あり＝自動追従中
}

const MARGIN = 40; // 対象工程の右端から縦線までの余白

export function deriveMilestoneGuides(core: Core, view: FlowLevelView): MilestoneGuide[] {
  const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const nodeByTask = new Map(taskNodes.map((n) => [n.taskId, n]));
  const out: MilestoneGuide[] = [];
  for (const n of taskNodes) {
    if (!isMilestone(core, n.taskId)) continue;
    const t = core.tasks[n.taskId]!;
    const xs = Object.values(core.dependencies)
      .filter((d) => d.to === t.id)
      .map((d) => nodeByTask.get(d.from))
      .filter((sn): sn is FlowTaskNode => !!sn)
      .map((sn) => sn.x + SIZE.task.w);
    const bound = xs.length > 0;
    out.push({ taskId: t.id, label: t.name, x: bound ? Math.max(...xs) + MARGIN : n.x, bound });
  }
  out.sort((a, b) => a.x - b.x || a.taskId.localeCompare(b.taskId));
  return out;
}
```

- [ ] **Step 4: PASS 確認＋全 suite** → **Step 5: コミット** `feat(core): マイルストーン縦線の導出 deriveMilestoneGuides`

---

### Task 3: 同期エンジン編集（複雑枠 — opus 実装・reconcile-invariant-reviewer レビュー必須）

**Files:**
- Modify: `packages/core/src/sync/reconcileFlow.ts`（5b/5c＋deriveParentBridges）
- Modify: `packages/core/src/sync/tidy.ts`
- Modify: `packages/core/src/sync/bands.ts`
- Test: `packages/core/test/milestone-sync.test.ts`（新規 golden）

**Interfaces:**
- Consumes: `isMilestone`（Task 1）
- Produces: MS 依存の導出エッジが生成されない view（Task 4 の描画前提）

- [ ] **Step 1: golden テストを書く**（add-sync-scenario パターン・counter 2 系統）:
  ① 工程A→MS の依存 → reconcile 後 **導出エッジ 0 本**・MS の FlowTaskNode は存在・A→B 等の
    通常エッジは従来どおり
  ② MS を含む状態の**冪等性**（2回目 reconcile: view 等値・added/removed 空）
  ③ 未紐付け MS の手動 x（`view.nodes[id] = {...n, x: 777}`）が reconcile 後も 777
  ④ `tidyFlowView` 実行後: MS ノードの x/y 不変・通常工程は整列される・レーン高さに MS が影響しない
  ⑤ `deriveBands`: MS ノードが親バンドの範囲を広げない（MS を右端に置いてもバンド幅が変わらない）
- [ ] **Step 2: FAIL 確認** → **Step 3: 実装**（各編集は最小・必ず `isMilestone` を使う）:
  1. `reconcileFlow` 5b（`for (const d of depsInScope)`）先頭に:
     ```ts
     if (isMilestone(core, d.to) || isMilestone(core, d.from)) {
       const ex = derivedByDep.get(d.id);
       if (ex) delete next.edges[ex.id]; // 過去に張られていた導出エッジも撤去（自己修復）
       continue;
     }
     ```
  2. 5c ブリッジループにも同ガード（`br.depId` の依存端点で判定。加えて
     `deriveParentBridges` の「先頭/末尾の子」の選定で MS タスクを候補から除外する —
     並び順先頭が MS だと橋の端点が MS ノードになるため）。
  3. `tidy.ts`: `deps` フィルタに `&& !isMilestone(core, d.from) && !isMilestone(core, d.to)` を追加し、
     `layoutNodes` のフィルタにも `&& !isMilestone(core, n.taskId)` を追加（両方入れる —
     依存フィルタだけだと hasDep=false 扱いで除外されるが、明示ガードで意図を残す）。
  4. `bands.ts`: `taskNodes` フィルタに `&& !isMilestone(core, n.taskId)` を追加。
- [ ] **Step 4: PASS＋全 suite＋typecheck** → **Step 5: コミット** `feat(sync): マイルストーンを導出エッジ・自動整列・親バンドから隔離`
- [ ] **Step 6: reconcile-invariant-reviewer エージェントでこのタスクの diff をレビュー**し、
  指摘があれば修正して再レビュー（PASS になるまで先へ進まない）。

---

### Task 4: 描画（FlowCanvas ＋ flowSvg）— 複雑枠: opus

**Files:**
- Modify: `apps/desktop/src/FlowCanvas.tsx`
- Modify: `apps/desktop/src/flowSvg.ts`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `deriveMilestoneGuides` / `isMilestone`（`@gantt-flow/core`）

- [ ] **Step 1: FlowCanvas**（アンカーはコード内容で特定）:
  1. `const bands = deriveBands(...)` の近くで `const msGuides = deriveMilestoneGuides(project.core, view);`
  2. `divNodes` から MS のタスクノードを除外（`n.kind === 'task' && isMilestone(project.core, n.taskId)` を弾く）
     — レーン内に通常ノードとして出さない。
  3. `.flow-scale` 内・bands の後に描画:
     - 縦破線: `top: 0` 〜 `lanesBottomY`、`left: g.x`、琥珀・opacity 0.55・`pointer-events: none`
     - 菱形＋ラベル: 上部余白（`top: 0` 付近・高さ ~28px の帯領域）に `left: g.x - 13`。
       クリックで該当タスクを選択（既存のノード選択と同じ store 経路）。
       **未紐付け（`!g.bound`）のときだけ**横ドラッグ可: pointerdown で既存のノード移動処理を
       流用し y は固定（`node.y` は変更しない）。bound のときはドラッグ無効（cursor: default）。
  4. 既存のノード選択・削除（Delete）・リネームが MS でも機能すること（taskId ベースの既存経路で
     動くはず — 動かない箇所だけ最小修正）。
  5. CSS: `.ms-diamond`（回転 45° の琥珀角丸四角・塗り薄）・`.ms-guide-line`（破線）・
     `.ms-label`。色は新規トークンを作らず `--warn` 系 or 既存の琥珀系トークンを探して使う
     （無ければ `color-mix` で `--lvl-large` から作らずに、styles.css の既存の amber/orange 系を確認）。
- [ ] **Step 2: flowSvg** — 同じ `deriveMilestoneGuides` で菱形（`<rect transform="rotate(45 …)">`）＋
  縦破線＋ラベルを出力。上部に MS 用の余白（`minY` を `-32` 程度に拡張、MS があるときだけ）。
- [ ] **Step 3: 検証** — `npm run typecheck -w @gantt-flow/desktop && npm test -w @gantt-flow/desktop`
- [ ] **Step 4: コミット** `feat(desktop): マイルストーンの菱形＋縦線描画（画面/SVG）`

---

### Task 5: 表・Inspector・作成導線

**Files:**
- Modify: `apps/desktop/src/TableView.tsx` / `apps/desktop/src/FullTable.tsx`
- Modify: `apps/desktop/src/Inspector.tsx`
- Modify: `apps/desktop/src/taskOps.ts`・`apps/desktop/src/quickAdd.ts`・`apps/desktop/src/ui/CommandPalette.tsx`・`apps/desktop/src/store.ts`（作成導線）

- [ ] **Step 1: 表** — MS 行に菱形バッジ（作業名の先頭・CSS `.ms-badge`）＋行の薄い琥珀背景。
  工程No・担当・工数セルは「—」表示（編集不可）。前工程列は既存のまま（対象工程の編集に使う）。
- [ ] **Step 2: Inspector** — MS 選択時は担当・工数・I/O・課題セクションを非表示にし、
  名前＋前工程（対象工程）＋備考だけにする。
- [ ] **Step 3: 作成導線** — ①表の行追加メニューに「マイルストーンを追加」②フローの追加ボタン列
  （▷ □ ◇ Y … の並び）に琥珀の ◆（`addTask` kind:'milestone'、現在ビューの level/scope で作成）
  ③コマンドパレットに「マイルストーンを追加」。すべて store の同一アクションを呼ぶ。
- [ ] **Step 4: 検証・コミット** — typecheck＋desktop テスト → `feat(desktop): マイルストーンの表・Inspector・作成導線`

---

### Task 6: MCP 対応

**Files:**
- Modify: `apps/mcp-server/src/batch.ts`（`add_task`/`upsert_task` op に `kind?`）
- Modify: `apps/mcp-server/src/tools.ts`（`add_task` ツールの zod に `kind: z.enum(['milestone']).optional()`）
- Test: `apps/mcp-server/test/batch.test.ts` に 1 ケース（kind 付き add_task → isMilestone 真）

- [ ] 実装 → `npm test -w @gantt-flow/mcp && npm run typecheck -w @gantt-flow/mcp` → コミット
  `feat(mcp): add_task/upsert_task に kind=milestone を追加`

---

### Task 7: 全体検証・実画面確認・PR

- [ ] `npm test --workspaces --if-present` / `npm run typecheck --workspaces --if-present` → 全緑
- [ ] puppeteer 実画面確認（前サイクルの `shot2.mjs` を流用・dev サーバ http://localhost:5173）:
  サンプルを開く → フロー中ビューで ◆ ボタンから MS 作成 → 菱形と縦線の表示 →
  表で前工程（対象工程）を設定 → 縦線が対象工程の右へ移動 → 対象工程ノードをドラッグ →
  線が追従 → 表での行表示（バッジ・—） → スクリーンショット一式を保存
- [ ] 最終ブランチレビュー（opus・review-package を merge-base から生成）
- [ ] push ＋ 事前入力 PR リンク生成（タイトル: `feat: マイルストーン（節目）を追加`）→
  スクリーンショットと合わせてユーザへ報告
