// Tauri デスクトップ殻のエントリ。Rust 側の責務は薄く: ファイル保存/競合検知/助言ロックのみ。
// 実体は fsstore（WebKit 非依存・テスト済み）。ドメイン・同期・描画は TS（packages/core, apps/desktop）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use fsstore::{AcquireResult, LockInfo};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// 深層防御: ファイル I/O コマンドは「ユーザーがダイアログで選んだパス」だけを許可する。
// webview(ほぼブラウザ)から呼ばれる #[tauri::command] は、もし XSS が 1 件でも混入すると
// 任意の path を渡せてしまい、ユーザー権限での任意ファイル読み書き(秘密鍵の窃取・
// 自動起動フォルダへのマルウェア設置など)に直結する。pick_open_path / pick_save_path が
// 返したパスだけをこの集合に登録し、save_project / open_project / stat / ロック系は
// 集合内のパスのみ受け付ける。これにより仮に webview 側が侵害されても、被害を
// 「ユーザーが明示的に選んだファイル」に限定できる。
#[derive(Default)]
struct AllowedPaths(Mutex<HashSet<PathBuf>>);

impl AllowedPaths {
    fn allow(&self, path: &Path) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(path.to_path_buf());
        }
    }
    fn is_allowed(&self, path: &Path) -> bool {
        self.0.lock().map(|set| set.contains(path)).unwrap_or(false)
    }
}

// 許可リストにあるパスのみ通す。無ければ拒否(コマンドは Err を返す)。
fn ensure_allowed(allowed: &AllowedPaths, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if allowed.is_allowed(&p) {
        Ok(p)
    } else {
        Err("許可されていないパスです（ファイルはダイアログから選んでください）".into())
    }
}

// ファイル I/O 系コマンドは async にする（Tauri 2 では async コマンドは別スレッドで
// 実行される）。同期コマンドはメインスレッドで走るため、SMB 等の遅い共有フォルダでは
// fsync のたびに UI が固まってしまう。fsstore 本体は同期のままでよい。

#[tauri::command]
async fn save_project(
    path: String,
    contents_b64: String,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<(), String> {
    let path = ensure_allowed(&allowed, &path)?;
    let bytes = B64
        .decode(contents_b64.as_bytes())
        .map_err(|e| format!("base64 decode error: {e}"))?;
    fsstore::atomic_save(&path, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_project(
    path: String,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<String, String> {
    let path = ensure_allowed(&allowed, &path)?;
    let bytes = fsstore::load(&path).map_err(|e| e.to_string())?;
    Ok(B64.encode(&bytes))
}

#[tauri::command]
async fn stat_updated_at(
    path: String,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<Option<String>, String> {
    let path = ensure_allowed(&allowed, &path)?;
    fsstore::stat_updated_at(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn acquire_lock(
    path: String,
    owner: LockInfo,
    stale_after_ms: i64,
    now_ms: i64,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<serde_json::Value, String> {
    let path = ensure_allowed(&allowed, &path)?;
    match fsstore::acquire_lock(&path, &owner, stale_after_ms, now_ms)
        .map_err(|e| e.to_string())?
    {
        AcquireResult::Acquired => Ok(serde_json::json!({ "ok": true })),
        // info=None（held: null）は「壊れた .lock が存在し保持者不明」。
        AcquireResult::Held { info, stale } => {
            Ok(serde_json::json!({ "ok": false, "held": info, "stale": stale }))
        }
    }
}

// 古い（stale な）ロックの引き継ぎ。expected には acquire_lock が返した held を渡す。
// 内容が変わっていた（先に他セッションが引き継いだ等）場合は false を返す。
#[tauri::command]
async fn steal_lock(
    path: String,
    owner: LockInfo,
    expected: Option<LockInfo>,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<bool, String> {
    let path = ensure_allowed(&allowed, &path)?;
    fsstore::steal_lock(&path, &owner, expected.as_ref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn refresh_lock(
    path: String,
    owner: LockInfo,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<(), String> {
    let path = ensure_allowed(&allowed, &path)?;
    fsstore::refresh_lock(&path, &owner).map_err(|e| e.to_string())
}

#[tauri::command]
async fn release_lock(
    path: String,
    owner: LockInfo,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<(), String> {
    let path = ensure_allowed(&allowed, &path)?;
    fsstore::release_lock(&path, &owner).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_lock(
    path: String,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<Option<LockInfo>, String> {
    let path = ensure_allowed(&allowed, &path)?;
    fsstore::read_lock(&path).map_err(|e| e.to_string())
}

fn file_path_to_string(p: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    let path = p.into_path().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ファイル選択ダイアログ。blocking_* はメインスレッドで呼ぶと固まるため
// async コマンド（別スレッドで実行される）にする。キャンセル時は None。
// 選ばれたパスは許可リストへ登録し、以後の I/O コマンドで受け付けられるようにする。
#[tauri::command]
async fn pick_open_path(
    app: tauri::AppHandle,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        // 専用拡張子 .gflow を既定にしつつ、旧 .json も開ける（後方互換）。
        .add_filter("gantt-flow", &["gflow", "json"])
        .blocking_pick_file()
        .map(file_path_to_string)
        .transpose()?;
    if let Some(path) = &picked {
        allowed.allow(Path::new(path));
    }
    Ok(picked)
}

#[tauri::command]
async fn pick_save_path(
    app: tauri::AppHandle,
    suggested_name: String,
    allowed: tauri::State<'_, AllowedPaths>,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        // 専用拡張子 .gflow を既定にしつつ、旧 .json での上書き保存も許す（後方互換）。
        .add_filter("gantt-flow", &["gflow", "json"])
        .set_file_name(suggested_name)
        .blocking_save_file()
        .map(file_path_to_string)
        .transpose()?;
    // 拡張子の補完はここ（許可リストに載る最終パス）で行う。Linux（GTK ポータル等）の保存
    // ダイアログは拡張子を自動付与しないため、拡張子無しのパスをそのまま許可リストに入れると、
    // フロント側が拡張子を足したパスが許可リストと一致せず保存が弾かれてしまう。
    // 既に .gflow / .json なら尊重し、無ければ既定の .gflow を付与する。
    let picked = picked.map(|p| {
        let lower = p.to_lowercase();
        if lower.ends_with(".gflow") || lower.ends_with(".json") {
            p
        } else {
            format!("{p}.gflow")
        }
    });
    if let Some(path) = &picked {
        allowed.allow(Path::new(path));
    }
    Ok(picked)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AllowedPaths::default());
            Ok(())
        })
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
