//! 共有フォルダ向けの安全な保存と助言ロック（`docs/05-persistence.md` §3）。
//! Tauri(Rust)側がこの薄い層を呼ぶ。ドメイン/同期/描画は TS 側（packages/core）。
//! ここは WebKit 非依存の純 Rust なので単体テスト可能。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn to_io<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::new(io::ErrorKind::Other, e.to_string())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string())
}

fn rand_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}", std::process::id(), nanos)
}

/// 同一ディレクトリ内の一時ファイルへ書き、fsync 後に rename（原子的置換）。
/// 途中でクラッシュしても元ファイルは無傷（rename 前なら一時ファイルだけが残る）。
pub fn atomic_save(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty());
    let dir = dir.unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".{}.tmp-{}", file_name(path), rand_suffix()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // rename が失敗したら一時ファイルを片付ける
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub fn load(path: &Path) -> io::Result<Vec<u8>> {
    fs::read(path)
}

/// 競合検知用に「ディスク上の更新時刻」を文字列(ms)で返す。無ければ None。
pub fn stat_updated_at(path: &Path) -> io::Result<Option<String>> {
    match fs::metadata(path) {
        Ok(m) => {
            let ms = m
                .modified()?
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Ok(Some(ms.to_string()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

// ---- 助言ロック ----

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct LockInfo {
    pub user: String,
    pub host: String,
    pub session_id: String,
    pub opened_at: i64,    // epoch ms
    pub heartbeat_at: i64, // epoch ms（呼び出し側が定期更新）
    pub app_version: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AcquireResult {
    Acquired,
    Held { info: LockInfo, stale: bool },
}

fn lock_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

pub fn read_lock(path: &Path) -> io::Result<Option<LockInfo>> {
    match fs::read(lock_path(path)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_lock(path: &Path, owner: &LockInfo) -> io::Result<()> {
    let bytes = serde_json::to_vec(owner).map_err(to_io)?;
    atomic_save(&lock_path(path), &bytes)
}

/// 取得を試みる。
/// - ロックが無い / 自分のセッション → 取得（書き込み）して Acquired
/// - 他者が保持 → Held{ stale }（新鮮なら stale=false、古ければ true=引き継ぎ候補）
pub fn acquire_lock(
    path: &Path,
    owner: &LockInfo,
    stale_after_ms: i64,
    now_ms: i64,
) -> io::Result<AcquireResult> {
    match read_lock(path)? {
        None => {
            write_lock(path, owner)?;
            Ok(AcquireResult::Acquired)
        }
        Some(info) => {
            if info.session_id == owner.session_id {
                write_lock(path, owner)?; // 自分のロックを更新
                return Ok(AcquireResult::Acquired);
            }
            let stale = now_ms - info.heartbeat_at > stale_after_ms;
            Ok(AcquireResult::Held { info, stale })
        }
    }
}

/// 放置/クラッシュ残骸のロックをユーザー確認の上で引き継ぐ（強制上書き）。
pub fn steal_lock(path: &Path, owner: &LockInfo) -> io::Result<()> {
    write_lock(path, owner)
}

/// ハートビート（heartbeat_at を更新した owner を渡す）。
pub fn refresh_lock(path: &Path, owner: &LockInfo) -> io::Result<()> {
    write_lock(path, owner)
}

/// 自分が保持している場合のみロックを解放（削除）。
pub fn release_lock(path: &Path, owner: &LockInfo) -> io::Result<()> {
    if let Some(info) = read_lock(path)? {
        if info.session_id == owner.session_id {
            let _ = fs::remove_file(lock_path(path));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("fsstore-test-{}", rand_suffix()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn owner(session: &str, heartbeat: i64) -> LockInfo {
        LockInfo {
            user: "alice".into(),
            host: "pc1".into(),
            session_id: session.into(),
            opened_at: heartbeat,
            heartbeat_at: heartbeat,
            app_version: "0".into(),
        }
    }

    #[test]
    fn atomic_save_and_load_roundtrip() {
        let d = TempDir::new();
        let p = d.file("project.json");
        atomic_save(&p, b"hello").unwrap();
        assert_eq!(load(&p).unwrap(), b"hello");
        // 上書きできる
        atomic_save(&p, b"world").unwrap();
        assert_eq!(load(&p).unwrap(), b"world");
        // 一時ファイルが残っていない
        let leftovers: Vec<_> = fs::read_dir(&d.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn stat_updated_at_some_after_save() {
        let d = TempDir::new();
        let p = d.file("a.json");
        assert_eq!(stat_updated_at(&p).unwrap(), None);
        atomic_save(&p, b"x").unwrap();
        assert!(stat_updated_at(&p).unwrap().is_some());
    }

    #[test]
    fn acquire_on_free_path() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let me = owner("s1", 1000);
        assert_eq!(acquire_lock(&p, &me, 90_000, 1000).unwrap(), AcquireResult::Acquired);
        assert_eq!(read_lock(&p).unwrap(), Some(me));
    }

    #[test]
    fn held_fresh_then_stale() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let other = owner("s_other", 1000);
        steal_lock(&p, &other).unwrap(); // 他者がロック中
        let me = owner("s_me", 1000);

        // まだ新鮮（now が heartbeat+1s、しきい値 90s）
        match acquire_lock(&p, &me, 90_000, 2000).unwrap() {
            AcquireResult::Held { stale, info } => {
                assert!(!stale);
                assert_eq!(info.session_id, "s_other");
            }
            _ => panic!("should be held"),
        }
        // 古い（now が heartbeat+100s）
        match acquire_lock(&p, &me, 90_000, 101_000).unwrap() {
            AcquireResult::Held { stale, .. } => assert!(stale),
            _ => panic!("should be held"),
        }
    }

    #[test]
    fn same_session_reacquires() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let me = owner("s1", 1000);
        steal_lock(&p, &me).unwrap();
        assert_eq!(acquire_lock(&p, &me, 90_000, 5000).unwrap(), AcquireResult::Acquired);
    }

    #[test]
    fn steal_and_release() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let other = owner("s_other", 1000);
        steal_lock(&p, &other).unwrap();
        let me = owner("s_me", 200_000);
        // 引き継ぎ
        steal_lock(&p, &me).unwrap();
        assert_eq!(read_lock(&p).unwrap().unwrap().session_id, "s_me");
        // 他者は解放できない（所有者でない）
        release_lock(&p, &other).unwrap();
        assert!(read_lock(&p).unwrap().is_some());
        // 所有者は解放できる
        release_lock(&p, &me).unwrap();
        assert_eq!(read_lock(&p).unwrap(), None);
    }
}
