# design-sync NOTES — gantt-flow Desktop

claude.ai/design project: **gantt-flow Desktop** (`4d424f88-8257-4159-8505-35678eae84d4`).
Shape: `package`. Target package: `@gantt-flow/desktop` (apps/desktop). Global: `window.GanttFlowDesktop`.

## このリポジトリは「アプリ」であって部品ライブラリではない
- gantt-flow は Tauri デスクトップアプリ(React + Vite SPA)。再利用可能なコンポーネントライブラリではない。
  Storybook なし、ライブラリ dist なし、barrel なし。今回は **best-effort 全取り込み**(ユーザー合意済み)。
- 既存の別プロジェクト「gant-flow design」(`cece4ea8-…`)には**手作業の設計成果**(ui_kits / guidelines / 旧抽出コンポーネント)が入っている。**触らないこと**。今回は別の新規プロジェクトに取り込んだ。

## ビルドの肝(再現に必須)
- **エントリは barrel** `.design-sync/entry.tsx`。`main.tsx` はトップレベルで `createRoot(document.getElementById('root')!).render()` + `initAutosave()` する副作用を持つため、synth-entry(全 .tsx を `export *`)は使えない。barrel で必要な 49 コンポーネント + `useApp`/`useUI`(seed 用)だけを明示 re-export する。
- **PKG_DIR は repo ルートに解決される**(`node_modules/@gantt-flow/desktop` の symlink をたどらない)。よって `cfg` のパッケージ相対パス(`srcDir`/`cssEntry`/`componentSrcMap`/`guidelinesGlob`)は **repo ルート基準**(`apps/desktop/src/...`)で書くこと。`src/...` と書くと styles.css も src も見つからない。
- `--node-modules ./node_modules`(repo ルート。react はここに hoist。apps/desktop/node_modules には react が無い)。
- ビルド/検証コマンド:
  - `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules --entry ./.design-sync/entry.tsx --out ./ds-bundle`
  - `node .ds-sync/package-validate.mjs ./ds-bundle`
  - ドライバ(初回は `--remote` 省略): `node .ds-sync/resync.mjs --config … --node-modules ./node_modules --entry ./.design-sync/entry.tsx --out ./ds-bundle`

## ⚠ UTF-8 charset の落とし穴(再 sync で再発する)
- バンドルに日本語の正規表現リテラル `/[^\w\-一-龠ぁ-んァ-ヶ。、ー]/g` が**生 UTF-8** で含まれる(esbuild は regex リテラル内を escape しない。charset:ascii でも回避不可)。
- スクリプトが **charset 未指定でロードされると Latin-1 解釈 → 正規表現が壊れ IIFE が throw → `window.GanttFlowDesktop` が空** になり、validate の `[BUNDLE_EXPORT] 49/49 not a component` が誤って fatal になる。プレビュー HTML は `<meta charset=utf-8>` があるので描画は正常。
- **対処(適用済み)**: `.ds-sync/storybook/http-serve.mjs` の MIME に `; charset=utf-8` を付与。**`.ds-sync/` は再 sync 時に skill から再コピーされるため、この 1 行修正は毎回再適用すること**(MIME 定義行に charset を足すだけ)。
- 本番(claude.ai/design)はページが UTF-8 前提なので問題は出ない見込み。

## seed の方法(プレビューで実画面を出す)
- データ画面: `import { useApp } from '@gantt-flow/desktop'; useApp.getState().loadSample()`(または `loadTemplate('order-to-ship'|'monthly-closing'|'procurement'|'onboarding')`)。Inspector は `useApp.getState().select(taskId)` で選択。io/issues は `project.details[id]` にある。
- overlay: `useUI.getState().setOverlay('help'|'palette'|'issues'|'summary'|'settings'|'backups')`、Modal は `useUI.setState({dialog:{kind:'confirm',…,resolve(){}}})`、Toaster は `useUI.getState().toast(msg,'success'|'info'|'error')`。
- 各プレビューは独立ページで読まれるので module 評価時に 1 度 seed すれば良い。

## 既知の warn(triage 済み・再 sync で「新規」と誤認しないため)
- `[FONT_MISSING] "Yu Gothic UI", "Cascadia Code"`: いずれも `--font-ui`/`--font-mono` の**フォントスタック内フォールバック**(先頭は `system-ui`)。ブランドフォントではない。Inter / Cascadia の woff2 は同梱済み(`fonts/`)。**system 代替で OK**(ユーザー方針)。`--no-render-check` ではなく放置で良い(非ブロッキング)。
- `tokens: 2 missing (below threshold)`: 未定義 CSS 変数 2 件、閾値以下で非ブロッキング。
- `[GRID_OVERFLOW]`: App/StatusBar=`cardMode:column`、overlay 系(CommandPalette/HelpDialog/IssueListDialog/Modal/SettingsDialog/SummaryDialog/Toaster)=`cardMode:single`+primaryStory を `cfg.overrides` に設定済み。

## floor card のまま(将来 authoring 可)
- `BackupsDialog`, `BusyOverlay`, `ErrorBoundary`, `Tour` の 4 つは未 authoring(floor card)。価値が低い/状態が特殊なため見送り。`Welcome`・`KeybindingsEditor` は authoring せずとも自動で実描画 OK。

## Re-sync risks(次回が静かに腐りうる点)
- **charset 修正の再適用**(上記)。これを忘れると validate が誤って fatal になる。
- **PKG_DIR=repo ルートの前提**。skill 側の解決ロジックが変わると componentSrcMap が総崩れになる(`(0 src-matched)` を見たら疑う)。
- **barrel と app ソースの乖離**: `apps/desktop/src` のコンポーネントを増減/改名したら `.design-sync/entry.tsx` と `cfg.componentSrcMap` を手で同期する必要がある(自動検出していない)。
- **seed プレビューは upstream API に依存**: `loadSample`/`loadTemplate`/`select`/`setOverlay`/`toast`/`project.details[].io/issues` のシグネチャが変わるとプレビューが空/壊れる。
- xlsx 等を含むため bundle は ~1.6MB と大きい(アップロードは大ファイルを単独チャンクにした)。
