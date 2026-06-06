# src-tauri — デスクトップ殻（Tauri 2）

Rust 側の責務は薄く、**ファイル保存・競合検知・助言ロック**のみ。実体は
[`crates/fsstore`](../../../crates/fsstore)（WebKit 非依存・`cargo test` 済み）に委譲し、
Tauri コマンド（`save_project` / `open_project` / `stat_updated_at` /
`acquire_lock` / `refresh_lock` / `release_lock` / `read_lock`）から呼ぶ。

> ⚠️ このリポジトリの CI/サンドボックスでは **WebKit と画面が無いためビルドしていません**。
> 以下は各自のマシンで実行してください。

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

## フロント連携の仕上げ（TODO）

現状フロントの保存/開くは**ブラウザのダウンロード/アップロード**。Tauri 配下では
`withGlobalTauri: true` なので `window.__TAURI__.core.invoke('save_project', { path, contents })`
等に差し替えると、共有フォルダへ**アトミック保存＋助言ロック**で書ける。
パス選択にはダイアログプラグイン（`tauri-plugin-dialog`）を足す。
土台は [`apps/desktop/src/persistence.ts`](../src/persistence.ts) にあり、`__TAURI__` 検出で分岐すればよい。
