// Tauri デスクトップ殻のエントリ。Rust 側の責務は薄く: ファイル保存/競合検知/助言ロックのみ。
// 実体は fsstore（WebKit 非依存・テスト済み）。ドメイン・同期・描画は TS（packages/core, apps/desktop）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use fsstore::{AcquireResult, LockInfo};

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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_project,
            open_project,
            stat_updated_at,
            acquire_lock,
            refresh_lock,
            release_lock,
            read_lock,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
