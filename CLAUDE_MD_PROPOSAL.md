# CLAUDE.md 追記提案（ux-overhaul で得た知見）

CLAUDE.md 本体は別ブランチで並行更新があるため**ここでは提案のみ**（本体は変更しない）。
以下は今回の作業で新設・確立した層と落とし穴。マージ担当が既存トーン・密度に合わせて取り込む前提の下書き。

## モノレポ構成への追記（core 側）

- `packages/core/src/lint.ts` — **業務リント（納品前チェック）**。`validate` の参照整合性に加え「納品物として未完成」な抜け（手順書欠落・担当未割当・工数未入力・課題の方策未記入 等）を列挙する純関数。決定論・読み取り専用。検証パネルとハンドブック出力前プリフライトが共有する単一ロジック。
- `packages/core/src/export/compareReport.ts` — **改善効果（As-Is→To-Be）の集計・行列生成**。`buildCompareReport` が工程別／担当別／構造差分をまとめ、Excel「改善効果」シート行と自己完結 HTML の両方の素になる。丸めは `round1`。
- `packages/core/src/metrics.ts` の追加関数 — `computeHearingProgress`（ヒアリング進捗＝末端かつ To-Be 新設でない工程を母数に状況別集計）／`computeProjectSummary`（プロジェクト要約）。サマリ・ステータスバー・チップが同一流儀で共有する純関数。

## desktop の共有機構への追記

- `ToastAction`（`ui/useUI.ts`）— トーストに「元に戻す」等のアクションボタンを載せる型。破壊的操作の完了トーストと undo を1本化する際の標準。
- `openWindowOrWarn`（`App.tsx`）— 別ウィンドウ（ハンドブック・改善効果レポート等）を開き、`window.open` が null を返したらトーストで警告する共通ラッパ。サブウィンドウ導線はこれ経由に統一。
- **`setBusy` + rAF パターン**（`App.tsx`）— 重い出力・印刷の直前に `useUI.setBusy('…')` → `await requestAnimationFrame(...)` でビジー表示を1フレーム描画させてから同期処理へ入り、`finally` 相当で `setBusy(null)`。UI 凍結を避ける定石。
- `statusUi.ts` — ヒアリング状況（status）の**ラベル・順序・select クラス・未ヒアリングノードのクラス（`hearingNodeClass`/`.st-unheard`）を一元管理**。status を表示する箇所はここを参照（分散定義を作らない）。
- `openComparison`（`ui/useUI.ts`）— 改善効果（比較）ダイアログを開く共有アクション。コマンドパレット・ホットキー（⌘⇧C）から呼ぶ。
- **`procedureFocus` シグナル**（`ui/useUI.ts` / `procShared.ts`）— 外部から手順書タブの特定章へジャンプさせる `{ taskId, seq }` 型シグナル（seq をインクリメントして同一 taskId でも再発火）。ビュー間フォーカス連携の雛形（inspectorIssueFocus 等を足すときの参考）。

## 開発 Tips への追記

- **PowerShell で `npm run dev -- --port 5174` は動かない** — `--port` フラグが npm 側に食われて Vite へ渡らない。Bash ツール経由で起動するか `npx vite --port 5174` のように vite を直接起動する。
- **worktree 運用時は node_modules を各 worktree で用意する** — ルートの `node_modules` は共有されない。新しい worktree では各自 `npm ci`（or `npm install`）を実行してから dev/test を回す。
