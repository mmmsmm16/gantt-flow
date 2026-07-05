# アプリ内 AI アシスト — 設計

日付: 2026-07-05 ／ ステータス: モック確認済み・ユーザレビュー待ち
視覚モック: scratchpad の ai-assist-mock.html（設定／メモ入力／提案リスト／差分プレビュー／適用バー。
プロバイダ選択ドロップダウンのみ本 spec で追加確定 — モック未反映の軽微差分）

## 目的・機能モデル（ロードマップで合意済み）

コンサルタントがヒアリングメモ（自由テキスト）を貼る → AI が「現プロジェクトへの変更提案リスト
（BatchOp 列）」を生成 → ユーザが **1 件ずつ 承認/修正/却下** → 承認分だけ commands 経由で一括適用
（**1 スナップショット＝undo 一発**）。手順書ドラフト（set_procedure / add_step）も同じ承認フローに載る。

## オフライン既定・オプトイン（方針の更新）

- **既定は完全オフライン**。AI 機能はオプトイン（設定でトグル・既定オフ・localStorage `gf-ai`）。
- `aiEnabled=false` のとき **ネットワーク呼び出しコードに一切到達しない**（実装ガード＋テストで固定）。
- 有効化レバーは 2 段: ①設定トグル ②CSP（tauri.conf.json の connect-src に
  `https://api.anthropic.com` と `https://*.openai.azure.com` のみ追加。ワイルドカード全開は禁止）。
- CLAUDE.md / VISION の「外部送信なし」を「既定オフライン・AI 有効時のみ、ユーザが設定した
  プロバイダへプロジェクト内容とメモを送信」に更新。

## プロバイダ抽象（ユーザ要件: 会社の Azure OpenAI キーでも使えること）

共通パイプライン: **プロンプト構築 → プロバイダ呼び出し（JSON テキスト取得）→ zod で BatchOp[] を
厳密検証 → 検証済み提案のみ UI へ**。スキーマ保証はプロバイダ側機能（下記）を使うが、
**最終防衛線は常に共通の zod 検証**（プロバイダ差で品質ゲートが変わらない）。

```ts
// apps/desktop/src/ai/provider.ts
export interface AiProviderConfig {
  kind: 'anthropic' | 'azure-openai';
  // anthropic: { apiKey, model }  … model 既定 'claude-opus-4-8'（'claude-sonnet-5'/'claude-haiku-4-5' 選択可）
  // azure-openai: { apiKey, endpoint, deployment, apiVersion }
}
export interface ProposalRequest { project: Project; memo: string; kind: 'batch' | 'procedureDraft'; targetTaskId?: Id }
export interface AiProvider {
  generateProposals(req: ProposalRequest, onProgress?: (chunk: string) => void): Promise<string /* JSON text */>;
}
```

- **Anthropic**: 公式 `@anthropic-ai/sdk`（desktop のみ依存追加・ブラウザ直接利用オプションで webview から使用）。
  構造化出力（`output_config.format` = BatchOp の JSON スキーマ）＋ストリーミング＋adaptive thinking。
  typed error（RateLimit/Auth 等）を UI 文言にマップ。`stop_reason: "refusal"` はエラーとして明示。
- **Azure OpenAI**: 生 fetch（`{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`）。
  `response_format: json_schema`（非対応デプロイは `json_object`＋プロンプト指示にフォールバック）。
- プロンプト（システム）は共通・日本語: 現プロジェクトの要約（工程木・担当・既存手順書の有無）＋
  BatchOp 語彙の説明＋「実在工程は taskId、同バッチ新設は ref で参照」規約。
  mcp-server の `build_from_minutes` プロンプト（prompts.ts）を土台に移植。

## API キーの保管（確認済み方針）

- **選択式**: 既定はセッション中のみ保持（メモリ）。「この PC に保存」チェックで localStorage
  （`gf-ai-key-*`）に保存。**平文である旨を UI に明記**（OS キーチェーン連携なしのため）。
- 設定エクスポート（SettingsFile）・autosave/backups・.gflow に**絶対含めない**（テストで固定）。
- 社内展開でキー配布が問題になった段階で「社内中継サーバ」を別途検討（本サイクル対象外）。

## BatchOp / runBatch の core 昇格

- `apps/mcp-server/src/batch.ts` を `packages/core/src/batch.ts` へ移設。
  **決定論化**: `runBatch(p, ops, idGen, now)`（直接 uuid / new Date を排除 — CLAUDE.md 規約準拠）。
  mcp-server は core を re-export し、tools.ts の `BatchOpSchema`（zod）も core へ移設して型と一元化。
- 既存 mcp テストは core へ移設＋counter() 化。mcp の write-through 動作は回帰テストで保証。

## 部分承認と ref-DAG リゾルバ

- 提案カードの状態: 未判定 / 承認 / 修正（インライン編集後は承認扱い）/ 却下。
- **却下の波及**: `ref` を参照する下流 op（add_dependency の from/to、set_detail の task 等）は
  参照先 op が却下されたら自動で「無効（依存先が却下されたため）」— 適用対象から除外しグレー表示。
  純関数 `resolveApproved(ops, decisions): { apply: BatchOp[]; disabled: Map<index, reason> }` として実装・単体テスト。
- 適用: `resolveApproved` の結果を（昇格後の）`runBatch` で畳み、store の新アクション
  `applyApprovedBatch` が `commit(result.project, 'AI提案を適用')` — **既存 commit 経由＝1 undo・
  reconcile は commit が担当**（runBatch は reconcile しない設計を維持）。

## UI（モック確認済み）

- 設定ダイアログに「AI」セクション: オプトイントグル／プロバイダ選択／プロバイダ別フィールド／
  モデル選択（Anthropic 時）／キー保存チェック。
- AI パネル（ドロワー or overlay・実装時に既存部品の流儀に合わせる）: メモ貼り付け → 生成
  （ストリーミング進捗）→ 提案カードリスト → 適用バー「承認 N 件を適用（undo で戻せます）」。
- 起動導線: ツールバー（AI 有効時のみ表示）＋コマンドパレット＋手順書タブの「✨ドラフト生成」
  ボタン（既存の disabled を活性化 — 対象工程を固定した procedureDraft モード）。
- 差分プレビュー: v1 は**ミニフロープレビュー**（追加工程=緑ゴースト・既存=減光。モックの模式と同等。
  FlowCompareView の完全な 2 プロジェクト比較への一般化は将来拡張）。
- エラー表示: 認証失敗／レート制限／スキーマ不一致（再生成ボタン）／refusal を個別文言で。

## テスト方針

- core: runBatch 移設＋決定論（counter/固定 now でバイト安定）・resolveApproved の DAG 単体
  （却下→下流無効・連鎖・無関係 op 不干渉）。
- desktop: プロバイダ層はネットワークをモックして「組み立てた リクエストの形」を検証
  （実 API は叩かない）。zod 検証の不正 JSON 拒否。**aiEnabled=false で fetch/SDK が呼ばれない**
  ことをスパイで固定。キーが SettingsFile エクスポートに含まれないこと。
  applyApprovedBatch が 1 undo であること（undo 一発で全提案が戻る）。
- 実機: モックプロバイダ（設定に隠しの 'mock' kind をテスト用に持つ or fetch スタブ）で
  E2E 操作 probe（メモ→提案→部分承認→適用→undo）。実 API のスモークはユーザ実機で 1 回。

## 対象外

- 社内中継サーバ／キーの集中管理
- Azure OpenAI 以外の追加プロバイダ（Gemini 等）
- 提案の適用履歴・学習（フィードバックループ）
- FlowCompareView の完全な 2 プロジェクト比較化（ミニプレビューで開始）
- プロンプトの継続チューニング（運用しながら改善）

## ビルド順序（目安）

1. core: runBatch 昇格＋決定論化＋BatchOpSchema 移設（mcp 追随・回帰）
2. desktop: プロバイダ層＋設定 UI（オプトイン/キー/プロバイダ）＋CSP
3. desktop: 提案 UI（カード/ref-DAG/ミニプレビュー/適用/undo）＋手順書タブ連携
4. 総合検証（オフライン担保・E2E probe・実 API スモーク）＋CLAUDE.md/VISION 更新
