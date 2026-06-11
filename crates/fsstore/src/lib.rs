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

/// rename をディスクへ確定させるため親ディレクトリを fsync する。
/// POSIX ではディレクトリエントリの永続化に必要（fsync(2)）。
/// 呼び出し側（atomic_save）でベストエフォート扱いなので、エラーはそのまま返す。
#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    fs::File::open(dir).and_then(|d| d.sync_all())
}

/// Windows ではディレクトリを File として開けないためベストエフォート（何もしない）。
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// 同一ディレクトリ内の一時ファイルへ書き、fsync 後に rename（原子的置換）。
/// 途中でクラッシュしても元ファイルは無傷（rename 前なら一時ファイルだけが残る）。
/// rename 後に親ディレクトリも fsync し、電源断で rename 自体が巻き戻らないようにする。
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
    // rename 後のディレクトリ fsync は「電源断で rename が巻き戻らない」ための保険であり、
    // この時点で置換自体は完了している。ここで Err を返すと実際は保存済みなのに失敗扱いに
    // なる（呼び出し側は dirty 維持・エラー表示）ため、完全にベストエフォートとして
    // 全エラーを黙認する（SMB 等ではディレクトリ fsync が PermissionDenied になり得る）。
    let _ = sync_dir(dir);
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

/// `.lock` ファイルおよび invoke 境界のワイヤ形式は camelCase
/// （TS 側 `ProjectRepository.ts` の LockInfo と一致させる）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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
    /// info=None は「.lock は存在するが JSON として読めず、保持者不明」
    /// （ワイヤ上は held: null, stale: false。TS 側 ProjectRepository.ts 参照）。
    Held { info: Option<LockInfo>, stale: bool },
}

fn lock_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

/// ロックファイルの読み取り結果。「無い」と「壊れていて読めない」を区別する
/// （acquire 時の扱いが異なるため）。
enum LockRead {
    Missing,
    Unreadable,
    Held(LockInfo),
}

fn read_lock_raw(path: &Path) -> io::Result<LockRead> {
    match fs::read(lock_path(path)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)
            .map(LockRead::Held)
            .unwrap_or(LockRead::Unreadable)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(LockRead::Missing),
        Err(e) => Err(e),
    }
}

pub fn read_lock(path: &Path) -> io::Result<Option<LockInfo>> {
    Ok(match read_lock_raw(path)? {
        LockRead::Held(info) => Some(info),
        _ => None,
    })
}

fn write_lock(path: &Path, owner: &LockInfo) -> io::Result<()> {
    let bytes = serde_json::to_vec(owner).map_err(to_io)?;
    atomic_save(&lock_path(path), &bytes)
}

/// ロックファイルを create_new（O_EXCL）で原子的に作成する。既存なら AlreadyExists。
fn try_create_lock(path: &Path, owner: &LockInfo) -> io::Result<()> {
    let bytes = serde_json::to_vec(owner).map_err(to_io)?;
    let lp = lock_path(path);
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lp)?;
    let written = f.write_all(&bytes);
    let written = written.and_then(|_| f.sync_all());
    if let Err(e) = written {
        // 書きかけの残骸を残さない（Windows ではハンドルを閉じてから削除）
        drop(f);
        let _ = fs::remove_file(&lp);
        return Err(e);
    }
    Ok(())
}

/// 取得を試みる。
/// - ロックが無い → create_new（O_EXCL）の原子的作成で取得。読み取り→書き込みの
///   隙間で複数セッションが同時に Acquired を得る競合を防ぐ。
/// - 自分のセッション → 内容を書き直して Acquired
/// - 他者が保持 → Held{ stale }（新鮮なら stale=false、古ければ true=引き継ぎ候補）
/// - 読めないロック → mtime で判断（古ければ残骸として引き継ぎ、新しければ保持者不明の Held）
pub fn acquire_lock(
    path: &Path,
    owner: &LockInfo,
    stale_after_ms: i64,
    now_ms: i64,
) -> io::Result<AcquireResult> {
    // 「作成失敗の直後に保持者が解放した」ケースに備えて数回やり直す。
    for _ in 0..3 {
        match try_create_lock(path, owner) {
            Ok(()) => return Ok(AcquireResult::Acquired),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        match read_lock_raw(path)? {
            LockRead::Missing => continue, // 直後に解放された → 作り直し
            LockRead::Held(info) => {
                if info.session_id == owner.session_id {
                    write_lock(path, owner)?; // 自分のロックの内容更新（rename 置換）
                    return Ok(AcquireResult::Acquired);
                }
                let stale = now_ms - info.heartbeat_at > stale_after_ms;
                return Ok(AcquireResult::Held { info: Some(info), stale });
            }
            LockRead::Unreadable => {
                // 壊れた（JSON として読めない）ロック。クラッシュ残骸かもしれないし、
                // 他セッションの try_create_lock（create→write の 2 段階）の書き込み
                // 途中を読んだだけかもしれない。固定スリープでの再読は SMB では書き込みに
                // 100ms 以上かかり得て不十分なので、ファイルの mtime で判断する:
                // - stale_after_ms より古い → 残骸とみなして引き継ぐ（rename 置換）
                // - それより新しい → 保持中とみなす（保持者不明: info=None, stale=false）
                let meta = match fs::metadata(lock_path(path)) {
                    Ok(m) => m,
                    // 直後に解放された → 作り直し
                    Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                };
                // mtime が取れない FS では「新しい」扱い（健全なロックを奪わない安全側）。
                // epoch 以前はあり得ないほど古い＝残骸扱い。
                let mtime_ms = match meta.modified() {
                    Ok(t) => t
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                    Err(_) => now_ms,
                };
                if now_ms - mtime_ms > stale_after_ms {
                    // ※ この引き継ぎだけは原子的でなく、同時に引き継ぐ他セッションと
                    //    競合し得る僅かな窓が残る（共有フォルダでは CAS が使えないため）。
                    write_lock(path, owner)?;
                    return Ok(AcquireResult::Acquired);
                }
                return Ok(AcquireResult::Held { info: None, stale: false });
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::Other,
        "ロックの取得が競合し続けました。再試行してください",
    ))
}

/// 放置/クラッシュ残骸のロックをユーザー確認の上で引き継ぐ（強制上書き）。
/// `expected` には確認ダイアログを出した時点で読んだ LockInfo を渡す。
/// 上書き直前に再読し、内容が変わっていた（保持者が更新した・別セッションが
/// 先に引き継いだ等）場合は何もせず false を返す。
/// ※ 再検証と rename の間にも僅かな競合窓は残る（共有フォルダ上で原子的な
///    compare-and-swap が使えないための既知の制約）。
pub fn steal_lock(path: &Path, owner: &LockInfo, expected: Option<&LockInfo>) -> io::Result<bool> {
    if let Some(expected) = expected {
        if read_lock(path)?.as_ref() != Some(expected) {
            return Ok(false);
        }
    }
    write_lock(path, owner)?;
    Ok(true)
}

/// ハートビート（heartbeat_at を更新した owner を渡す）。
/// 既存ロックを読み、自分のセッションが保持している場合のみ書き換える。
/// 所有者チェック無しで上書きすると、引き継ぎ（steal）後も旧保持者の定期ハートビートが
/// 新しいロックを黙って奪い返してしまうため。不在/他者保持/読めない場合は Err を返す
/// （TS 側のハートビートは失敗したら更新を諦めるだけでよい。上書きはここで防がれている）。
/// ※ 読み取り→書き込みの間に僅かな競合窓は残る（共有フォルダでは CAS が使えないため）。
pub fn refresh_lock(path: &Path, owner: &LockInfo) -> io::Result<()> {
    match read_lock(path)? {
        Some(info) if info.session_id == owner.session_id => write_lock(path, owner),
        _ => Err(io::Error::new(
            io::ErrorKind::Other,
            "lock not held by this session",
        )),
    }
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
        assert!(steal_lock(&p, &other, None).unwrap()); // 他者がロック中
        let me = owner("s_me", 1000);

        // まだ新鮮（now が heartbeat+1s、しきい値 90s）
        match acquire_lock(&p, &me, 90_000, 2000).unwrap() {
            AcquireResult::Held { stale, info } => {
                assert!(!stale);
                assert_eq!(info.expect("owner should be known").session_id, "s_other");
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
        assert!(steal_lock(&p, &me, None).unwrap());
        assert_eq!(acquire_lock(&p, &me, 90_000, 5000).unwrap(), AcquireResult::Acquired);
    }

    #[test]
    fn steal_and_release() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let other = owner("s_other", 1000);
        assert!(steal_lock(&p, &other, None).unwrap());
        let me = owner("s_me", 200_000);
        // 引き継ぎ
        assert!(steal_lock(&p, &me, None).unwrap());
        assert_eq!(read_lock(&p).unwrap().unwrap().session_id, "s_me");
        // 他者は解放できない（所有者でない）
        release_lock(&p, &other).unwrap();
        assert!(read_lock(&p).unwrap().is_some());
        // 所有者は解放できる
        release_lock(&p, &me).unwrap();
        assert_eq!(read_lock(&p).unwrap(), None);
    }

    #[test]
    fn refresh_updates_own_lock() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let me = owner("s1", 1000);
        assert!(steal_lock(&p, &me, None).unwrap());
        refresh_lock(&p, &owner("s1", 2000)).unwrap();
        assert_eq!(read_lock(&p).unwrap().unwrap().heartbeat_at, 2000);
    }

    #[test]
    fn refresh_does_not_clobber_after_steal() {
        // 引き継ぎ（steal）後、旧保持者のハートビートはロックを奪い返せない
        let d = TempDir::new();
        let p = d.file("p.json");
        let old_holder = owner("s_old", 1000);
        assert!(steal_lock(&p, &old_holder, None).unwrap());
        let new_holder = owner("s_new", 200_000);
        assert!(steal_lock(&p, &new_holder, Some(&old_holder)).unwrap());

        assert!(refresh_lock(&p, &owner("s_old", 300_000)).is_err());
        assert_eq!(read_lock(&p).unwrap().unwrap().session_id, "s_new");
    }

    #[test]
    fn refresh_fails_when_lock_missing() {
        let d = TempDir::new();
        let p = d.file("p.json");
        assert!(refresh_lock(&p, &owner("s1", 1000)).is_err());
    }

    #[test]
    fn steal_verifies_expected_content() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let stale_holder = owner("s_stale", 1000);
        assert!(steal_lock(&p, &stale_holder, None).unwrap());

        // 先に別セッションが引き継いでいた → expected と一致せず失敗
        let first = owner("s_first", 200_000);
        assert!(steal_lock(&p, &first, Some(&stale_holder)).unwrap());
        let second = owner("s_second", 200_000);
        assert!(!steal_lock(&p, &second, Some(&stale_holder)).unwrap());
        assert_eq!(read_lock(&p).unwrap().unwrap().session_id, "s_first");

        // 読んだ内容のままなら引き継げる
        assert!(steal_lock(&p, &second, Some(&first)).unwrap());
        assert_eq!(read_lock(&p).unwrap().unwrap().session_id, "s_second");
    }

    #[test]
    fn acquire_does_not_clobber_existing_lock() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let other = owner("s_other", 1000);
        assert!(steal_lock(&p, &other, None).unwrap());
        let me = owner("s_me", 1000);
        match acquire_lock(&p, &me, 90_000, 2000).unwrap() {
            AcquireResult::Held { .. } => {}
            _ => panic!("should be held"),
        }
        // 既存ロックは上書きされていない
        assert_eq!(read_lock(&p).unwrap().unwrap().session_id, "s_other");
    }

    /// テスト用: 実時間の epoch ms（壊れたロックの mtime 判定は実ファイルの mtime と比較するため）。
    fn real_now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn acquire_takes_over_unreadable_lock_with_stale_mtime() {
        let d = TempDir::new();
        let p = d.file("p.json");
        // クラッシュ残骸（JSON として壊れたロックファイル）。mtime は「今」なので、
        // しきい値を超えた未来の now を渡して「古い残骸」を再現する。
        fs::write(lock_path(&p), b"{broken").unwrap();
        let me = owner("s_me", 1000);
        let now = real_now_ms() + 120_000; // mtime + 90s 超
        assert_eq!(acquire_lock(&p, &me, 90_000, now).unwrap(), AcquireResult::Acquired);
        assert_eq!(read_lock(&p).unwrap(), Some(me));
    }

    #[test]
    fn acquire_holds_off_unreadable_lock_with_fresh_mtime() {
        let d = TempDir::new();
        let p = d.file("p.json");
        // 書き込み途中（create→write の 2 段階）を読んだ可能性があるケース。
        // mtime が新しい間は奪わず、保持者不明（info=None）の Held を返す。
        fs::write(lock_path(&p), b"{broken").unwrap();
        let me = owner("s_me", 1000);
        match acquire_lock(&p, &me, 90_000, real_now_ms()).unwrap() {
            AcquireResult::Held { info, stale } => {
                assert_eq!(info, None);
                assert!(!stale);
            }
            _ => panic!("should be held"),
        }
        // 既存の（壊れた）ロックファイルは上書きされていない
        assert_eq!(fs::read(lock_path(&p)).unwrap(), b"{broken");
    }

    #[test]
    fn concurrent_acquire_yields_single_winner() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let acquired = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            for i in 0..8 {
                let p = &p;
                let acquired = &acquired;
                s.spawn(move || {
                    let me = owner(&format!("s{}", i), 1000);
                    match acquire_lock(p, &me, 90_000, 1000).unwrap() {
                        AcquireResult::Acquired => {
                            acquired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        AcquireResult::Held { .. } => {}
                    }
                });
            }
        });
        // O_EXCL により勝者はちょうど 1 セッションだけ
        assert_eq!(acquired.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn lock_file_json_is_camel_case() {
        let d = TempDir::new();
        let p = d.file("p.json");
        let me = owner("s1", 1000);
        assert!(steal_lock(&p, &me, None).unwrap());
        let raw = String::from_utf8(fs::read(lock_path(&p)).unwrap()).unwrap();
        // TS 側（ProjectRepository.ts）の LockInfo と同じ camelCase キー
        assert!(raw.contains("\"sessionId\""));
        assert!(raw.contains("\"openedAt\""));
        assert!(raw.contains("\"heartbeatAt\""));
        assert!(raw.contains("\"appVersion\""));
        assert!(!raw.contains("session_id"));
    }
}
