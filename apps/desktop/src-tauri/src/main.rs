// Tauri デスクトップ殻のエントリ。Rust 側の責務は薄く: ファイル保存/競合検知/助言ロックのみ。
// 実体は fsstore（WebKit 非依存・テスト済み）。ドメイン・同期・描画は TS（packages/core, apps/desktop）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use fsstore::{AcquireResult, LockInfo};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn save_project(path: String, contents: String) -> Result<(), String> {
    fsstore::atomic_save(&PathBuf::from(path), contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_project(path: String) -> Result<String, String> {
    let bytes = fsstore::load(&PathBuf::from(path)).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn stat_updated_at(path: String) -> Result<Option<String>, String> {
    fsstore::stat_updated_at(&PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn acquire_lock(
    path: String,
    owner: LockInfo,
    stale_after_ms: i64,
    now_ms: i64,
) -> Result<serde_json::Value, String> {
    match fsstore::acquire_lock(&PathBuf::from(path), &owner, stale_after_ms, now_ms)
        .map_err(|e| e.to_string())?
    {
        AcquireResult::Acquired => Ok(serde_json::json!({ "ok": true })),
        AcquireResult::Held { info, stale } => {
            Ok(serde_json::json!({ "ok": false, "held": info, "stale": stale }))
        }
    }
}

// 古い（stale な）ロックの引き継ぎ。expected には acquire_lock が返した held を渡す。
// 内容が変わっていた（先に他セッションが引き継いだ等）場合は false を返す。
#[tauri::command]
fn steal_lock(path: String, owner: LockInfo, expected: Option<LockInfo>) -> Result<bool, String> {
    fsstore::steal_lock(&PathBuf::from(path), &owner, expected.as_ref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn refresh_lock(path: String, owner: LockInfo) -> Result<(), String> {
    fsstore::refresh_lock(&PathBuf::from(path), &owner).map_err(|e| e.to_string())
}

#[tauri::command]
fn release_lock(path: String, owner: LockInfo) -> Result<(), String> {
    fsstore::release_lock(&PathBuf::from(path), &owner).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_lock(path: String) -> Result<Option<LockInfo>, String> {
    fsstore::read_lock(&PathBuf::from(path)).map_err(|e| e.to_string())
}

fn file_path_to_string(p: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    let path = p.into_path().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ファイル選択ダイアログ。blocking_* はメインスレッドで呼ぶと固まるため
// async コマンド（別スレッドで実行される）にする。キャンセル時は None。
#[tauri::command]
async fn pick_open_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
        .map(file_path_to_string)
        .transpose()
}

#[tauri::command]
async fn pick_save_path(app: tauri::AppHandle, suggested_name: String) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(suggested_name)
        .blocking_save_file()
        .map(file_path_to_string)
        .transpose()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_project,
            open_project,
            stat_updated_at,
            acquire_lock,
            steal_lock,
            refresh_lock,
            release_lock,
            read_lock,
            pick_open_path,
            pick_save_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
