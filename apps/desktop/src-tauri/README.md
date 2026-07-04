# src-tauri — デスクトップ殻（Tauri 2）

Rust 側の責務は薄く、**ファイル保存・競合検知・助言ロック**のみ。実体は
[`crates/fsstore`](../../../crates/fsstore)（WebKit 非依存・`cargo test` 済み）に委譲し、
Tauri コマンド（`save_project` / `open_project` / `stat_updated_at` /
`acquire_lock` / `steal_lock` / `refresh_lock` / `release_lock` / `read_lock` /
`pick_open_path` / `pick_save_path`）から呼ぶ。

> ⚠️ このリポジトリの CI/サンドボックスでは **WebKit と画面が無いため実機バイナリをビルドしていません**。
> 以下は各自のマシンで実行してください（Rust コマンドとフロント配線のコード自体は実装済み）。

## 前提（Linux の例）

```bash
# システム依存（Debian/Ubuntu 系）
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget \
  file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
# Tauri CLI
npm i -D @tauri-apps/cli@^2
# アイコン一式を生成（icons/icon.png から）
npx tauri icon apps/desktop/src-tauri/icons/icon.png
```

macOS / Windows は Tauri の前提（Xcode CLT / Visual Studio Build Tools）に従う。

## 開発・ビルド

```bash
# リポジトリのルートから
npx tauri dev --config apps/desktop/src-tauri/tauri.conf.json
npx tauri build --config apps/desktop/src-tauri/tauri.conf.json
```

`tauri dev` は `beforeDevCommand`（`npm run dev`＝Vite）を起動し、その画面を
ネイティブウィンドウで表示する。

## フロント連携（実装済み）

フロントの保存/開くは [`apps/desktop/src/persistence.ts`](../src/persistence.ts) が
`__TAURI__` 検出（`isTauri()`）で分岐し、Tauri 配下では
`window.__TAURI__.core.invoke('save_project', { path, contentsB64 })` 等を呼んで
（ファイル内容は base64 のバイト列で受け渡す）、
共有フォルダへ**アトミック保存＋助言ロック**で書く（ブラウザ配下は File System
Access API／ダウンロードにフォールバック）。パス選択は `pick_save_path` /
`pick_open_path`（`tauri-plugin-dialog`、`main.rs` で登録済み）を経由し、選ばれた
パスだけが Rust 側のパス許可リストに載る。

## ファイル形式と関連付け（`.gflow`）

プロジェクトの保存拡張子は **`.gflow`**（中身は v2 ZIP コンテナ＝`project.json`＋`assets/`。
旧単一 JSON も読み込みのみ後方互換）。`tauri.conf.json` の
`bundle.fileAssociations` で OS に関連付けるため、インストール後は **`.gflow` の既定アプリが
gantt-flow になり、専用アイコンが付く**（テキストエディタへの誤関連付けを避けられる）。
開く際は旧 `.json` も受け付ける（後方互換）。

> 残作業（TODO）: **ダブルクリックした `.gflow` をそのまま読み込む**には、起動引数
> （Windows/Linux は `argv`、macOS は `RunEvent::Opened`）でパスを受け取り、許可リストへ
> 登録してフロントへ渡す配線が必要。現状は関連付けにより本アプリで開くが、起動後に
> 「開く」で選ぶ必要がある。

残作業は **実機バイナリのビルド/実行**（上記「開発・ビルド」）・上記のダブルクリック起動配線・E2E。
