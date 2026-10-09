//! pair-landlock: paired-coding's Linux write fence.
//!
//! Reads one JSON ruleset from the first line of stdin, turns it into a Landlock ruleset that
//! handles every file-system write right the running kernel supports, sets no_new_privs,
//! restricts itself, and execs `/bin/sh -c <command>`. Everything on stdin after the first
//! newline is left unread for the command. See README.md beside this crate for the contract.

use serde::Deserialize;
use std::ffi::CString;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

/// Landlock is missing, disabled, or its ABI is below 3. The caller falls back to bwrap.
const EXIT_UNSUPPORTED: i32 = 120;
/// The ruleset on stdin, or the command line, is not acceptable. Nothing ran.
const EXIT_INPUT: i32 = 121;
/// A Landlock or prctl call failed while building or enforcing the ruleset. Nothing ran.
const EXIT_SANDBOX: i32 = 122;
/// The ruleset was enforced but /bin/sh could not be executed.
const EXIT_EXEC: i32 = 123;

/// The lowest ABI the fence accepts: ABI 3 is the first that can deny truncate(2).
const MIN_ABI: i64 = 3;
/// The largest ruleset line accepted on stdin.
const MAX_RULESET_BYTES: usize = 16 << 20;

// include/uapi/linux/landlock.h
const CREATE_RULESET_VERSION: u32 = 1 << 0;
const RULE_PATH_BENEATH: u32 = 1;
const WRITE_FILE: u64 = 1 << 1;
const REMOVE_DIR: u64 = 1 << 4;
const REMOVE_FILE: u64 = 1 << 5;
const MAKE_CHAR: u64 = 1 << 6;
const MAKE_DIR: u64 = 1 << 7;
const MAKE_REG: u64 = 1 << 8;
const MAKE_SOCK: u64 = 1 << 9;
const MAKE_FIFO: u64 = 1 << 10;
const MAKE_BLOCK: u64 = 1 << 11;
const MAKE_SYM: u64 = 1 << 12;
const REFER: u64 = 1 << 13;
const TRUNCATE: u64 = 1 << 14;
const RESOLVE_UNIX: u64 = 1 << 16;
const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;

/// Rights on a listed file: rewrite it and truncate it.
const FILE_RIGHTS: u64 = WRITE_FILE | TRUNCATE;
/// Rights on a `dirs` tree: create regular files and write them. Landlock checks WRITE_FILE
/// when the new file is opened, against the new file's path, so creating without writing is
/// all MAKE_REG alone allows; WRITE_FILE and TRUNCATE therefore reach every existing file in
/// the tree as well.
const DIR_RIGHTS: u64 = MAKE_REG | WRITE_FILE | TRUNCATE;

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct Ruleset {
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    dirs: Vec<DirEntry>,
    #[serde(default)]
    rw_trees: Vec<String>,
    command: String,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct DirEntry {
    path: String,
    #[serde(default)]
    make_dir: bool,
}

struct Fail(i32, String);

fn fail<T>(code: i32, msg: impl Into<String>) -> Result<T, Fail> {
    Err(Fail(code, msg.into()))
}

/// Every write right the ABI handles, plus pathname Unix-socket connects from ABI 9.
/// Reading and executing stay unhandled, so they stay allowed.
fn handled_fs(abi: i64) -> u64 {
    let mut h = WRITE_FILE
        | REMOVE_DIR
        | REMOVE_FILE
        | MAKE_CHAR
        | MAKE_DIR
        | MAKE_REG
        | MAKE_SOCK
        | MAKE_FIFO
        | MAKE_BLOCK
        | MAKE_SYM;
    if abi >= 2 {
        h |= REFER;
    }
    if abi >= 3 {
        h |= TRUNCATE;
    }
    if abi >= 9 {
        h |= RESOLVE_UNIX;
    }
    h
}

/// Abstract Unix sockets outside the sandbox are unreachable from ABI 6.
fn scoped(abi: i64) -> u64 {
    if abi >= 6 {
        SCOPE_ABSTRACT_UNIX_SOCKET
    } else {
        0
    }
}

/// A temp tree gets every handled right except REFER (never granted) and RESOLVE_UNIX
/// (a socket a process outside the sandbox made under /tmp stays unreachable).
fn rw_tree_rights(handled: u64) -> u64 {
    handled & !(REFER | RESOLVE_UNIX)
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn os_err(e: i32) -> String {
    io::Error::from_raw_os_error(e).to_string()
}

/// The running Landlock ABI, or the errno that says why there is none.
fn running_abi() -> Result<i64, i32> {
    // SAFETY: a NULL attr with size 0 and the VERSION flag only queries the ABI.
    let r = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            CREATE_RULESET_VERSION,
        )
    };
    if r < 0 {
        Err(errno())
    } else {
        Ok(r as i64)
    }
}

/// The ABI the fence runs on, or EXIT_UNSUPPORTED when there is none or it is below 3.
fn classify(abi: Result<i64, i32>) -> Result<i64, Fail> {
    match abi {
        Err(e) => fail(EXIT_UNSUPPORTED, format!("Landlock is unavailable on this kernel ({})", os_err(e))),
        Ok(abi) if abi < MIN_ABI => fail(
            EXIT_UNSUPPORTED,
            format!("Landlock ABI {abi} is below {MIN_ABI}, so truncation cannot be denied"),
        ),
        Ok(abi) => Ok(abi),
    }
}

/// The first line of stdin, read one byte at a time so nothing after the newline is consumed.
fn read_ruleset_line() -> Result<Vec<u8>, Fail> {
    let mut line = Vec::new();
    let mut byte = 0u8;
    loop {
        // SAFETY: reads at most one byte into a valid one-byte buffer.
        let n = unsafe { libc::read(0, (&mut byte as *mut u8).cast(), 1) };
        if n < 0 {
            let e = errno();
            if e == libc::EINTR {
                continue;
            }
            return fail(EXIT_INPUT, format!("reading the ruleset from stdin: {}", os_err(e)));
        }
        if n == 0 || byte == b'\n' {
            return Ok(line);
        }
        if line.len() == MAX_RULESET_BYTES {
            return fail(EXIT_INPUT, format!("the ruleset line is longer than {MAX_RULESET_BYTES} bytes"));
        }
        line.push(byte);
    }
}

fn parse(line: &[u8]) -> Result<Ruleset, Fail> {
    let rs: Ruleset = match serde_json::from_slice(line) {
        Ok(rs) => rs,
        Err(e) => return fail(EXIT_INPUT, format!("the ruleset is not valid: {e}")),
    };
    if rs.command.is_empty() {
        return fail(EXIT_INPUT, "the ruleset has an empty command");
    }
    Ok(rs)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    File,
    Dir,
}

/// Opens `path` with O_PATH for a rule. The path must be absolute and canonical (no symlink
/// anywhere in it, no `.` or `..`), so the rule lands on the object the caller named. A file
/// must be a regular file with one link, or a character device; a directory must be one.
fn open_for_rule(path: &str, kind: Kind) -> Result<i32, Fail> {
    if !path.starts_with('/') {
        return fail(EXIT_INPUT, format!("{path:?} is not an absolute path"));
    }
    let canon = match std::fs::canonicalize(path) {
        Ok(c) => c,
        Err(e) => return fail(EXIT_INPUT, format!("{path:?}: {e}")),
    };
    // Byte comparison: Path equality would treat "/a/./b" and "/a//b" as "/a/b".
    if canon.as_os_str().as_bytes() != path.as_bytes() {
        return fail(
            EXIT_INPUT,
            format!("{path:?} is not canonical (it resolves to {:?}); pass the resolved path", canon),
        );
    }
    let c = match CString::new(Path::new(path).as_os_str().as_bytes()) {
        Ok(c) => c,
        Err(_) => return fail(EXIT_INPUT, format!("{path:?} contains a NUL byte")),
    };
    // SAFETY: c is a valid NUL-terminated path.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 {
        return fail(EXIT_INPUT, format!("{path:?}: {}", os_err(errno())));
    }
    // SAFETY: fd is open; st is a plain struct the kernel fills.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } < 0 {
        let e = errno();
        unsafe { libc::close(fd) };
        return fail(EXIT_INPUT, format!("{path:?}: {}", os_err(e)));
    }
    let fmt = st.st_mode & libc::S_IFMT;
    let problem = match kind {
        Kind::Dir if fmt != libc::S_IFDIR => Some("is not a directory".to_string()),
        Kind::File if fmt == libc::S_IFDIR => {
            Some("is a directory; list it under dirs or rw_trees, not files".to_string())
        }
        Kind::File if fmt == libc::S_IFREG && st.st_nlink != 1 => Some(format!(
            "has {} hard links; a write right on it would reach every other name for the same file",
            st.st_nlink
        )),
        Kind::File if fmt != libc::S_IFREG && fmt != libc::S_IFCHR => {
            Some("is not a regular file or a character device".to_string())
        }
        _ => None,
    };
    if let Some(p) = problem {
        unsafe { libc::close(fd) };
        return fail(EXIT_INPUT, format!("{path:?} {p}"));
    }
    Ok(fd)
}

/// Every (fd, rights, path) the ruleset grants, opened before anything is enforced.
fn rules_for(rs: &Ruleset, handled: u64) -> Result<Vec<(i32, u64, String)>, Fail> {
    let mut wanted: Vec<(&str, Kind, u64)> = Vec::new();
    for f in &rs.files {
        wanted.push((f, Kind::File, FILE_RIGHTS));
    }
    for d in &rs.dirs {
        wanted.push((&d.path, Kind::Dir, if d.make_dir { DIR_RIGHTS | MAKE_DIR } else { DIR_RIGHTS }));
    }
    for t in &rs.rw_trees {
        wanted.push((t, Kind::Dir, rw_tree_rights(handled)));
    }
    let mut out = Vec::with_capacity(wanted.len());
    for (path, kind, rights) in wanted {
        let fd = open_for_rule(path, kind)?;
        out.push((fd, rights & handled, path.to_string()));
    }
    Ok(out)
}

fn enforce(abi: i64, rules: &[(i32, u64, String)]) -> Result<(), Fail> {
    let handled = handled_fs(abi);
    let attr = RulesetAttr { handled_access_fs: handled, handled_access_net: 0, scoped: scoped(abi) };
    // SAFETY: attr is a valid landlock_ruleset_attr prefix of the size passed.
    let ruleset = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0u32,
        )
    };
    if ruleset < 0 {
        return fail(EXIT_SANDBOX, format!("landlock_create_ruleset: {}", os_err(errno())));
    }
    let ruleset = ruleset as i32;
    for (fd, rights, path) in rules {
        if *rights == 0 {
            continue;
        }
        let rule = PathBeneathAttr { allowed_access: *rights, parent_fd: *fd };
        // SAFETY: rule is a valid packed landlock_path_beneath_attr.
        let r = unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                ruleset,
                RULE_PATH_BENEATH,
                &rule as *const PathBeneathAttr,
                0u32,
            )
        };
        if r < 0 {
            return fail(EXIT_SANDBOX, format!("landlock_add_rule {path:?}: {}", os_err(errno())));
        }
        unsafe { libc::close(*fd) };
    }
    // SAFETY: plain prctl and syscall with integer arguments.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0 {
        return fail(EXIT_SANDBOX, format!("prctl(PR_SET_NO_NEW_PRIVS): {}", os_err(errno())));
    }
    if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0u32) } < 0 {
        return fail(EXIT_SANDBOX, format!("landlock_restrict_self: {}", os_err(errno())));
    }
    unsafe { libc::close(ruleset) };
    Ok(())
}

fn run() -> Result<(), Fail> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => {}
        [a] if a == "--abi" => {
            let abi = running_abi();
            println!("{}", abi.unwrap_or(0));
            let _ = io::stdout().flush();
            return classify(abi).map(|_| ());
        }
        _ => return fail(EXIT_INPUT, "usage: pair-landlock [--abi]  (ruleset JSON on the first line of stdin)"),
    }
    let abi = classify(running_abi())?;
    let rs = parse(&read_ruleset_line()?)?;
    let rules = rules_for(&rs, handled_fs(abi))?;
    enforce(abi, &rules)?;
    let err = Command::new("/bin/sh").arg("-c").arg(&rs.command).exec();
    fail(EXIT_EXEC, format!("exec /bin/sh: {err}"))
}

fn main() {
    if let Err(Fail(code, msg)) = run() {
        let _ = writeln!(io::stderr(), "pair-landlock: {msg}");
        std::process::exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_below_three_or_missing_is_unsupported() {
        let code = |r: Result<i64, Fail>| match r {
            Ok(abi) => abi as i32,
            Err(Fail(c, _)) => -c,
        };
        assert_eq!(code(classify(Err(libc::ENOSYS))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Err(libc::EOPNOTSUPP))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Ok(1))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Ok(2))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Ok(3))), 3);
        assert_eq!(code(classify(Ok(6))), 6);
    }

    #[test]
    fn handled_rights_follow_the_abi() {
        assert_eq!(handled_fs(3) & REFER, REFER);
        assert_eq!(handled_fs(3) & TRUNCATE, TRUNCATE);
        assert_eq!(handled_fs(2) & TRUNCATE, 0);
        assert_eq!(handled_fs(8) & RESOLVE_UNIX, 0);
        assert_eq!(handled_fs(9) & RESOLVE_UNIX, RESOLVE_UNIX);
        // Reading, listing and executing are never handled, so they stay allowed.
        assert_eq!(handled_fs(99) & 0b1101, 0);
        assert_eq!(scoped(5), 0);
        assert_eq!(scoped(6), SCOPE_ABSTRACT_UNIX_SOCKET);
    }

    #[test]
    fn refer_is_never_granted() {
        for abi in 3..=12 {
            let h = handled_fs(abi);
            assert_eq!(rw_tree_rights(h) & REFER, 0);
            assert_eq!(rw_tree_rights(h) & RESOLVE_UNIX, 0);
            assert_eq!((DIR_RIGHTS | MAKE_DIR | FILE_RIGHTS) & REFER, 0);
        }
    }

    #[test]
    fn parse_rejects_unknown_fields_and_empty_commands() {
        assert!(parse(br#"{"command":"true"}"#).is_ok());
        assert!(parse(br#"{"command":"true","dirs":[{"path":"/x","make_dir":true}]}"#).is_ok());
        assert!(parse(br#"{"command":"true","refer":["/x"]}"#).is_err());
        assert!(parse(br#"{"command":"true","dirs":[{"path":"/x","refer":true}]}"#).is_err());
        assert!(parse(br#"{"command":""}"#).is_err());
        assert!(parse(br#"{"files":[]}"#).is_err());
    }

    #[test]
    fn rule_paths_must_be_absolute_canonical_and_the_right_kind() {
        let base = std::env::temp_dir().join(format!("pair-landlock-test-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let base = std::fs::canonicalize(&base).unwrap();
        let file = base.join("f");
        std::fs::write(&file, b"x").unwrap();
        let link = base.join("l");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let hard = base.join("h");
        let other = base.join("o");
        std::fs::write(&hard, b"x").unwrap();
        let _ = std::fs::remove_file(&other);
        std::fs::hard_link(&hard, &other).unwrap();
        let s = |p: &Path| p.to_str().unwrap().to_string();
        let code = |r: Result<i32, Fail>| match r {
            Ok(fd) => {
                unsafe { libc::close(fd) };
                0
            }
            Err(Fail(c, _)) => c,
        };
        assert_eq!(code(open_for_rule(&s(&file), Kind::File)), 0);
        assert_eq!(code(open_for_rule(&s(&base), Kind::Dir)), 0);
        assert_eq!(code(open_for_rule("relative/path", Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&link), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&format!("{}/./f", s(&base)), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&format!("{}//f", s(&base)), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&format!("{}/", s(&base)), Kind::Dir)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&base), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&file), Kind::Dir)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&hard), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&base.join("missing")), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule("/dev/null", Kind::File)), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
