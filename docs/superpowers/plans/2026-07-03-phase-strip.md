# フェーズ帯（大工程ヘッダストリップ）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** フロー図上部に大工程（フェーズ）ごとの横帯を常設し、どの領域がどのフェーズか一目で分かるようにする（画面＋SVG エクスポート両対応）。

**Architecture:** core に純関数 `derivePhaseStrip(core, view)` を新設（`bands.ts` と同型・永続化なし・reconcile 非接触）。desktop は `.lane-rail` と同じ「スクロール容器直下の absolute レール＋ scroll で transform 固定」パターンの上部版で描画。SVG は同じ導出関数を共有。スペック: `docs/superpowers/specs/2026-07-03-phase-strip-design.md`。

**Tech Stack:** TypeScript（core: 依存なし・vitest / desktop: React 18）。

## Global Constraints

- ブランチ `feature/phase-strip`（作成済み）で作業。main 直コミット禁止。
- `packages/core` に React/Tauri/ブラウザ API を持ち込まない（純 TS・Node でテスト可能）。
- `reconcileFlow` 本体・`bands.ts`・モデル型（`model/types.ts`）・スキーマは**変更しない**（導出関数の追加のみ）。
- テストは決定論: ID は `counter()` 注入、`Date.now`/`Math.random` 禁止。
- ファイル編集は Write/Edit ツールのみ（PowerShell `Out-File` 禁止・UTF-16 破損防止）。
- 命名・コメントは既存ファイルの流儀（日本語コメント・簡潔）に合わせる。

---

### Task 1: core — `derivePhaseStrip` と golden テスト（TDD）

**Files:**
- Create: `packages/core/src/sync/phaseStrip.ts`
- Modify: `packages/core/src/index.ts`（`export * from './sync/phaseStrip';` を `./sync/bands` の export 行の直後に追加）
- Test: `packages/core/test/phaseStrip.test.ts`

**Interfaces:**
- Consumes: `Core`/`FlowLevelView`/`FlowTaskNode`/`Id`（`../model/types`）、`SIZE`（`./autoPlace`）
- Produces: `derivePhaseStrip(core: Core, view: FlowLevelView): PhaseSegment[]` と
  `interface PhaseSegment { taskId: Id; label: string; x: number; width: number }`
  （Task 2・3 が `@gantt-flow/core` から import する）

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/test/phaseStrip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { addTask, renameTask } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { derivePhaseStrip } from '../src/sync/phaseStrip';
import type { FlowTaskNode } from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName } from './helpers';

const taskNodes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

// 大2件（見積 / 契約）＋各配下に中2件のプロジェクトを組む共通ヘルパ。
function buildTwoPhases() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: '見積', level: 'large' }, g);
  p = addTask(p, { name: '契約', level: 'large' }, g);
  const mitsumori = taskIdByName(p, '見積');
  const keiyaku = taskIdByName(p, '契約');
  p = addTask(p, { name: '要件整理', level: 'medium', parentId: mitsumori }, g);
  p = addTask(p, { name: '見積作成', level: 'medium', parentId: mitsumori }, g);
  p = addTask(p, { name: '契約書作成', level: 'medium', parentId: keiyaku }, g);
  p = addTask(p, { name: '締結', level: 'medium', parentId: keiyaku }, g);
  return { p, mitsumori, keiyaku };
}

describe('derivePhaseStrip', () => {
  it('中ビュー → 大工程ごとに1セグメント・x範囲がメンバーを包含・x昇順', () => {
    const { p, mitsumori, keiyaku } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), counter('n'));
    const segs = derivePhaseStrip(p.core, res.view);
    expect(segs.map((s) => s.taskId).sort()).toEqual([mitsumori, keiyaku].sort());
    expect(segs.map((s) => s.label)).toContain('見積');
    // 各セグメントはメンバーの x 範囲（±PAD）を包含する
    for (const seg of segs) {
      const members = taskNodes(res.view).filter((n) => p.core.tasks[n.taskId]!.parentId === seg.taskId);
      const minX = Math.min(...members.map((n) => n.x));
      expect(seg.x).toBeLessThanOrEqual(minX);
      expect(seg.x + seg.width).toBeGreaterThan(Math.max(...members.map((n) => n.x)));
    }
    // x 昇順で安定
    const xs = segs.map((s) => s.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('大ビュー → 常に空（ノード自体がフェーズ）', () => {
    const { p } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('large'), counter('n'));
    expect(derivePhaseStrip(p.core, res.view)).toEqual([]);
  });

  it('スコープ付きビュー → 単一セグメントに退化', () => {
    const { p, mitsumori } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium', mitsumori), counter('n'));
    const segs = derivePhaseStrip(p.core, res.view);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.taskId).toBe(mitsumori);
  });

  it('x範囲が交差しても詰め直さない（重なりは事実の表現）', () => {
    const { p, mitsumori, keiyaku } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), counter('n'));
    // 契約側の1ノードを見積側の領域へ手動移動（手動配置の再現）
    const view = { ...res.view, nodes: { ...res.view.nodes } };
    const moved = taskNodes(res.view).find((n) => p.core.tasks[n.taskId]!.parentId === keiyaku)!;
    view.nodes[moved.id] = { ...moved, x: 0 };
    const segs = derivePhaseStrip(p.core, view);
    const a = segs.find((s) => s.taskId === mitsumori)!;
    const b = segs.find((s) => s.taskId === keiyaku)!;
    expect(b.x).toBeLessThan(a.x + a.width); // 重なったまま返る
  });

  it('リネーム（データのみ編集）→ ラベルだけ変わり x/width 不変', () => {
    const { p, mitsumori } = buildTwoPhases();
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), counter('n'));
    const before = derivePhaseStrip(p.core, res.view);
    const p2 = renameTask(p, mitsumori, '見積フェーズ');
    const after = derivePhaseStrip(p2.core, res.view);
    expect(after.find((s) => s.taskId === mitsumori)!.label).toBe('見積フェーズ');
    expect(after.map(({ label, ...rest }) => rest)).toEqual(before.map(({ label, ...rest }) => rest));
  });
});
```

注: `addTask`/`renameTask` の引数シグネチャは `packages/core/src/commands/index.ts` を実装前に確認し、
異なる場合はテスト側をそれに合わせる（`parentId` の渡し方・`renameTask(p, id, name)` の順序）。

- [ ] **Step 2: 失敗を確認**

Run: `npm test -w @gantt-flow/core -- phaseStrip`
Expected: FAIL（`derivePhaseStrip` が存在しない / モジュール解決エラー）

- [ ] **Step 3: 実装**

`packages/core/src/sync/phaseStrip.ts`:

```ts
// フェーズ帯（大工程ヘッダストリップ）の導出（docs/superpowers/specs/2026-07-03-phase-strip-design.md）。
// 表示中のタスクノードの祖先をたどり、大工程ごとに x 範囲の帯を計算する。保存しない。
// bands.ts と同じ導出パターンだが、こちらは上部の固定帯用に x 軸のみ・大工程のみ。
import type { Core, FlowLevelView, FlowTaskNode, Id } from '../model/types';
import { SIZE } from './autoPlace';

export interface PhaseSegment {
  taskId: Id; // フェーズ＝大工程タスク
  label: string;
  x: number;
  width: number;
}

const PAD_X = 12; // bands.ts の帯と同じ左右余白

export function derivePhaseStrip(core: Core, view: FlowLevelView): PhaseSegment[] {
  if (view.level === 'large') return []; // ノード自体がフェーズなので帯は出さない
  const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
  const acc = new Map<Id, { minX: number; maxX: number }>();

  for (const node of taskNodes) {
    const right = node.x + SIZE.task.w;
    let parentId = core.tasks[node.taskId]?.parentId;
    const visited = new Set<Id>(); // 親参照に循環があっても止まる（bands.ts と同じ保険）
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const ancestor = core.tasks[parentId];
      if (!ancestor) break;
      if (ancestor.level === 'large') {
        const cur = acc.get(parentId);
        if (cur) {
          cur.minX = Math.min(cur.minX, node.x);
          cur.maxX = Math.max(cur.maxX, right);
        } else {
          acc.set(parentId, { minX: node.x, maxX: right });
        }
        break;
      }
      parentId = ancestor.parentId;
    }
  }

  const segs: PhaseSegment[] = [];
  for (const [taskId, v] of acc) {
    segs.push({
      taskId,
      label: core.tasks[taskId]!.name,
      x: v.minX - PAD_X,
      width: v.maxX - v.minX + PAD_X * 2,
    });
  }
  // 重なりは許容（依存順レイアウトでは大工程ごとの x 範囲は排他でない）。詰め直さない。
  segs.sort((a, b) => a.x - b.x || a.taskId.localeCompare(b.taskId));
  return segs;
}
```

`packages/core/src/index.ts` の `export * from './sync/bands';` の直後に追加:

```ts
export * from './sync/phaseStrip';
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -w @gantt-flow/core -- phaseStrip`
Expected: PASS（5件）

Run: `npm test -w @gantt-flow/core && npm run typecheck -w @gantt-flow/core`
Expected: 全テスト PASS・型エラーなし

- [ ] **Step 5: コミット**

```bash
git add packages/core/src/sync/phaseStrip.ts packages/core/src/index.ts packages/core/test/phaseStrip.test.ts
git commit -m "feat(core): フェーズ帯の導出 derivePhaseStrip を追加

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: desktop — FlowCanvas の上部フェーズレール＋CSS

**Files:**
- Modify: `apps/desktop/src/FlowCanvas.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `derivePhaseStrip` / `type PhaseSegment`（`@gantt-flow/core`・Task 1 が export 済み）
- Produces: なし（画面表示のみ）

実装は `.lane-rail`（担当ラベルの左固定レール）と同じパターンの**上固定版**。既存コードの該当箇所:
レール参照 `laneRailRef` は FlowCanvas.tsx:127、scroll 固定 effect は 465-475、レール JSX は 1892 付近、
CSS は styles.css:1154（`.lane-rail`）。

- [ ] **Step 1: FlowCanvas.tsx を編集**

1. import（15-33 行の `@gantt-flow/core` import リスト）に `derivePhaseStrip` を追加。
2. `laneRailRef`（127 行）の直後に追加:

```ts
  const phaseRailRef = useRef<HTMLDivElement>(null); // フェーズ帯（縦スクロールで上端に貼り付く）
```

3. scroll 固定 effect（465-475 行）の `pin` を拡張（lane-rail は translateX、phase-rail は translateY）:

```ts
    const pin = () => {
      const rail = laneRailRef.current;
      if (rail) rail.style.transform = `translateX(${scroller.scrollLeft}px)`;
      const prail = phaseRailRef.current;
      if (prail) prail.style.transform = `translateY(${scroller.scrollTop}px)`;
    };
```

4. 描画データ（610 行 `const bands = deriveBands(...)` の直後）:

```ts
  const phases = derivePhaseStrip(project.core, view);
```

5. `.lane-rail` の JSX ブロック（1892-…）の**直後**（同じ階層＝`.flow-canvas` 直下）に追加:

```tsx
        {phases.length > 0 && (
          <div className="phase-rail" ref={phaseRailRef} style={{ width: CANVAS_W * scale }}>
            {phases.map((p, i) => (
              <div
                key={p.taskId}
                className={`phase-seg${i % 2 ? ' phase-seg-alt' : ''}`}
                style={{ left: p.x * scale, width: p.width * scale }}
                title={`フェーズ: ${p.label}`}
              >
                <span className="phase-seg-label">{p.label}</span>
              </div>
            ))}
          </div>
        )}
```

- [ ] **Step 2: styles.css にレールのスタイルを追加**

`.lane-rail` ブロック（1154 行〜）の近くに追加。**色は既存の帯トークン（`--lvl-large`・`--band-stroke`・
`.band-label` の配色）を再利用**し、新しい色変数を定義しない:

```css
/* フェーズ帯: キャンバス上端に大工程ごとの横帯（縦スクロールで貼り付き）。band と同じ配色系。 */
.phase-rail {
  position: absolute;
  left: 0;
  top: 0;
  height: 24px;
  z-index: 5; /* lane-rail(4) より上・ノードには干渉しない（pointer-events none） */
  pointer-events: none;
  will-change: transform;
}
.phase-seg {
  position: absolute;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  padding: 0 8px;
  overflow: hidden;
  white-space: nowrap;
  border-bottom: 2px solid color-mix(in srgb, var(--lvl-large) 55%, var(--band-stroke));
  background: color-mix(in srgb, var(--lvl-large) 18%, transparent);
  border-radius: 0 0 8px 8px;
}
.phase-seg-alt {
  background: color-mix(in srgb, var(--lvl-large) 9%, transparent);
}
.phase-seg-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--band-label, var(--fg));
  text-overflow: ellipsis;
  overflow: hidden;
}
```

注: `--band-label` が存在しない場合は `.band-label`（styles.css:1141 付近）が使う色トークンを確認して
同じものを使う。ダーク/ライト両テーマで視認できることを確認する。

- [ ] **Step 3: 型チェックと目視スモーク**

Run: `npm run typecheck -w @gantt-flow/desktop`
Expected: エラーなし
（画面の実確認は Task 4 の Playwright ステップでまとめて行う）

- [ ] **Step 4: コミット**

```bash
git add apps/desktop/src/FlowCanvas.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): フロー上部にフェーズ帯レールを表示

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: desktop — SVG エクスポートにフェーズ帯を出力

**Files:**
- Modify: `apps/desktop/src/flowSvg.ts`

**Interfaces:**
- Consumes: `derivePhaseStrip`（`@gantt-flow/core`）

- [ ] **Step 1: flowSvg.ts を編集**

1. import リスト（3-18 行）に `derivePhaseStrip` を追加。
2. 図の範囲計算の完了直後・`const width = maxX - minX;`（72 行付近）の**前**に、帯の分だけ上へ拡張:

```ts
  // フェーズ帯: 画像上端に大工程ごとの横帯を出す（画面の phase-rail と同じ導出）。
  const phases = derivePhaseStrip(project.core, view);
  const STRIP_H = 22;
  let stripY = 0;
  if (phases.length) {
    for (const p of phases) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + p.width);
    }
    stripY = minY - STRIP_H - 6;
    minY = stripY - 6;
  }
```

3. 背景 `<rect>`（79 行）と `<defs>`（80-82 行）の後・bands ループ（84 行〜）の**前**に描画を追加:

```ts
  for (const [i, p] of phases.entries()) {
    parts.push(
      `<rect x="${p.x}" y="${stripY}" width="${p.width}" height="${STRIP_H}" rx="4" fill="${FLOW_LIGHT.band}" fill-opacity="${i % 2 ? 0.1 : 0.18}"/>`,
    );
    parts.push(
      `<text x="${p.x + 6}" y="${stripY + 15}" font-size="11" font-weight="600" fill="${FLOW_LIGHT.bandLabel}">${esc(p.label)}</text>`,
    );
  }
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck -w @gantt-flow/desktop && npm test -w @gantt-flow/desktop`
Expected: エラーなし・既存テスト PASS

- [ ] **Step 3: コミット**

```bash
git add apps/desktop/src/flowSvg.ts
git commit -m "feat(desktop): SVGエクスポートにフェーズ帯を出力

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 全体検証（テスト・Playwright 自走確認）と PR

**Files:** なし（検証と PR のみ。Playwright スクリーンショットは scratchpad へ保存）

- [ ] **Step 1: 全ワークスペースのテスト・型チェック**

Run: `npm test --workspaces --if-present` / `npm run typecheck --workspaces --if-present`
Expected: すべて PASS

- [ ] **Step 2: Playwright MCP による自走確認**

1. `npm run dev -w @gantt-flow/desktop` をバックグラウンド起動（http://localhost:5173）。
2. Playwright MCP（`.mcp.json` の `playwright`）でページを開き:
   - Welcome からサンプルプロジェクト（または新規＋大2/中4 の工程を作成）を用意
   - 中粒度のフロービューを表示 → **上部にフェーズ帯が出る**ことをスクリーンショットで確認
   - 縦スクロール → 帯が上端に貼り付く / 横スクロール → 帯が内容と一緒に動く
   - ズーム変更 → 帯の位置・幅が追従する
   - 大粒度ビュー → 帯が出ないことを確認
3. スクリーンショットを撮り、結果（確認項目と OK/NG）をレポートに記録。NG があれば修正してから進む。
4. dev サーバを停止。

- [ ] **Step 3: push と PR 作成**

```bash
git push -u origin feature/phase-strip
```

`gh` CLI はこの PC に無いため、PR は事前入力リンク方式:
`https://github.com/mmmsmm16/gantt-flow/compare/main...feature/phase-strip?quick_pull=1&title=...&body=...`
を生成してユーザに提示する（タイトル: `feat: フロー図上部にフェーズ帯（大工程ヘッダストリップ）を追加`、
本文: 概要・スペックへのリンク・動作確認結果・スクリーンショット添付の案内、末尾に
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`）。マージはユーザ判断。
