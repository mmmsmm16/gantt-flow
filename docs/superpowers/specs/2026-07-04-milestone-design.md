# マイルストーン — 設計

日付: 2026-07-04 / ステータス: 承認済み（視覚モックでユーザ確認済み・opus 設計検証済み）
視覚版モック: claude.ai Artifact「マイルストーン モック」（final-bound-to-tasks 版が確定仕様）

## 目的

業務フロー上に「節目」を置き、**この節目までにどの工程を終わらせる必要があるか**を表現する。
日付は持たない（順序ベース）。スケジュール計算はしない（将来拡張の余地のみ残す）。

## 確定 UX（ユーザ確認済み・2026-07-04）

- フロー上は**レーンの上の専用余白に置く独立した琥珀の菱形**＋**全レーンを貫く縦の破線**。
  工程との**矢印は描かない**（縦線が「ここまで」を表す）。
- データ上は**対象工程と紐付く**: 入依存（工程 → マイルストーン）＝「この節目までに終わらせる工程」。
  **縦線の x は対象工程ノードの右端の最大値＋余白に自動追従**（工程を動かせば線も動く）。
- 対象工程が無い（未紐付け）ときだけ菱形を左右に手動ドラッグ可。紐付けたら自動追従が優先。
- マイルストーンから**出る依存は禁止**。子工程・担当・工数も持たない。
- 表では菱形バッジ＋薄い琥珀の1行。**工程No 採番・工数集計から除外**。
  「前工程」列＝対象工程（既存の依存編集 UI をそのまま使う）。
- 粒度スコープは工程と同じ（中ビューに作れば中ビューに出る）。

## モデル設計

- `ProcessTask.kind?: 'milestone'`（オプション・**スキーマ bump 不要**。Zod は
  `kind: z.literal('milestone').optional()`）。
- マイルストーンは reconcile 上は通常タスクとして **1:1 の FlowTaskNode を保持**する
  （1:1 不変条件と `property.test.ts` のノード数アサーションを維持。未紐付け時の手動 x の永続化にも使う）。
- 中央ヘルパ `isMilestone(core, id)` を core に置き、全ガードがこれを参照する（判定の分散を防ぐ）。

## 同期エンジンへの変更（検証で必須と確定した3点）

1. **導出エッジの生成時ガード**: `reconcileFlow` の導出エッジ生成（5b）と親ブリッジ（5c）で
   `to` がマイルストーンの依存は**エッジを作らない**（描画側での抑制はしない —
   エッジは障害物計算・tidy に漏れるため生成層で止める）。
2. **tidy（自動整列）から除外**: `tidy.ts` は `core.dependencies` を直接読むため、
   マイルストーンノードをレイアウト対象・レーン高さ計算から除外（未紐付けの手動 x が
   自動整列で飛ぶのを防ぐ）。
3. **bands から除外**: `deriveBands` の集計対象からマイルストーンノードを除外
   （親範囲バンドがマイルストーンまで伸びるのを防ぐ）。

## コマンド・集計ガード

- `addDependency`: `from` がマイルストーンなら拒否（出依存禁止）。
- `deleteTask` / `deleteTaskKeepChildren` のブリッジ依存生成にも同ガード（`addDependency` を
  経由しない生成があるため。共有ヘルパで実装）。
- `addTask` / `reparentTask`: 親がマイルストーンなら拒否（子を持てない）。
- `codes.ts`: マイルストーンは工程No を持たず、兄弟の採番インデックスも消費しない。
- `compare.ts`: `leafIds` / `leafCount` / 工数集計から除外（`criticalPathDays` は重み0の
  終端になるため変更不要）。
- `validate.ts`: 「マイルストーンに子がいる / 出依存がある」を検出するルールを追加。

## 導出（描画用・bands パターン）

新規 `packages/core/src/sync/milestoneGuides.ts`（純関数・保存しない）:

```
deriveMilestoneGuides(core, view): { taskId, label, x, bound }[]
// bound = 入依存が1件以上。x = bound ? max(対象工程ノード.x + SIZE.task.w) + MARGIN : 自ノード.x
```

FlowCanvas と flowSvg の両方が消費（画面と SVG 出力の一致を構造的に保証）。

## デスクトップ描画・UI

- FlowCanvas: マイルストーンの**レーン内タスクノードは描かず**、上部余白に菱形＋ラベル、
  そこから縦破線を lanesBottom まで描く。未紐付け時のみ菱形を横ドラッグ可（`node.x` を更新）。
- flowSvg: 同じ導出で菱形＋縦線を出力。
- 表（TableView / FullTable）: バッジ付き行・担当/工数/工程No は「—」・前工程列は既存 UI。
- 作成導線: 表の行追加メニュー「マイルストーンを追加」／フローの追加ボタン列に ◆／コマンドパレット。
- Inspector: 対象工程（前工程）の編集は既存の依存エディタを流用。担当・工数欄は非表示。

## MCP

- `add_task` / `upsert_task`（tools と batch op）に任意の `kind` パラメータを追加。
- `add_dependency` は core のガードを継承（マイルストーン from は BatchOp 実行時にエラー）。

## テスト方針

- ゴールデン（add-sync-scenario パターン）: ①工程→MS 依存で**導出エッジ0**かつ MS ノード存続
  ②MS を含む状態での冪等性（2回目 reconcile で added/removed 空）③対象工程の x 変更で
  guide の x が追従 ④未紐付け MS の手動 x が reconcile を跨いで保持 ⑤tidy が MS の x を動かさない。
- 単体: codes 採番スキップ（後続の番号が飛ばない）/ compare 除外 / addDependency 出依存拒否 /
  削除ブリッジのガード / validate ルール。
- 後方互換: `kind` 無しの既存ファイルがそのまま読めること（スキーマテスト）。

## ビルド順序（実装計画の骨子）

1. core モデル＋ガード（types/schema/commands/codes/compare/validate）— 機械的
2. `milestoneGuides.ts` 導出（テストファースト）
3. **同期エンジン編集（reconcileFlow 5b/5c ガード・tidy/bands 除外）— 複雑枠: opus 実装
   ＋ reconcile-invariant-reviewer レビュー必須**
4. 描画（FlowCanvas / flowSvg）— 未紐付けドラッグの状態遷移が要注意
5. 表・Inspector・作成導線
6. MCP・全体検証（Playwright 実画面＋スクリーンショット送付）

## 対象外

- 日付・スケジュール計算（逆算・遅延判定）
- 全粒度共通マイルストーン（粒度ごとで開始。要望が出たら再設計）
- マイルストーンの一括管理 UI（一覧・並び替え等）
