# pair-landlock

paired-coding's write fence for Linux kernels with Landlock. It reads a ruleset, forks, and
the child restricts itself with Landlock so that only the listed paths can be written, then
runs `/bin/sh -c <command>`. Every process the command starts inherits the restriction, and
nothing inside can lift it. The helper itself stays outside the sandbox as the command's
supervisor: when the command ends, it kills every process the command started, including
ones that left its process group (see **Supervision** below).

The gate builds the ruleset from the same pairing state as the macOS Seatbelt profile. This
directory holds the helper alone: the Rust source, two static binaries, their checksums, the
build script, and the live tests.

## Usage

```sh
pair-landlock --abi                 # print the kernel's Landlock ABI (0 if none)
printf '%s\n' "$RULESET_JSON" | pair-landlock
printf '%s\n%s' "$RULESET_JSON" "$DATA" | pair-landlock   # the command reads $DATA on stdin
```

The ruleset is the **first line of stdin**, as one line of JSON. The helper reads stdin one
byte at a time up to the first newline, so everything after that line is left for the
command. `pair_write` can pipe file content straight through.

## Ruleset

```json
{
  "files": ["/abs/path/to/file"],
  "dirs": [{ "path": "/abs/dir", "make_dir": false, "remove": false }],
  "rw_trees": ["/abs/temp/dir"],
  "command": "shell command line"
}
```

Unknown fields are refused. Every list may be omitted, and `command` must not be empty.

| Field | Grants | What it allows |
|---|---|---|
| `files` | `WRITE_FILE`, `TRUNCATE` on that one file | Rewrite, append to, and truncate the file. Nothing else: the file cannot be renamed, deleted, or created again. |
| `dirs` | `MAKE_REG`, `WRITE_FILE`, `TRUNCATE` on the tree, plus `MAKE_DIR` when `make_dir` is true, plus `REMOVE_FILE` and `REFER` when `remove` is true | Create regular files anywhere under the directory and write them. Every file already under it becomes writable too (see below). Creating subdirectories needs `make_dir`. With `remove`, files under it can be deleted and renamed, which `rm`, `mv` and `sed -i` need; without it, deleting and renaming stay refused. Symlinks and removing directories stay refused either way. `make_dir` and `remove` default to false. |
| `rw_trees` | Every handled right except `REFER` and `RESOLVE_UNIX` | Temp paths: create, write, delete, and rename within one directory. |

Every path must be:
- **absolute and canonical.** It must be byte-identical to its `realpath`, with no symlink in any component, no `.`, no `..`, no `//`, and no trailing `/`. A rule lands on the object the path resolves to, so the helper insists the caller names that object.
- **already in existence.** Landlock attaches a rule to an existing inode, so a file that does not exist yet cannot get a rule of its own. Put its parent directory in `dirs` instead.
- **the right kind.** A `files` entry must be a regular file with exactly one hard link, or a character device such as `/dev/null`. `dirs` and `rw_trees` entries must be directories.

No path is writable unless it is listed, and that includes `/dev/null`. A command that
redirects to `/dev/null` needs `/dev/null` in `files`. The Seatbelt profile allows the same
short list, which the caller passes explicitly.

### Why `dirs` grants WRITE_FILE

Landlock checks `WRITE_FILE` when the new file is opened, against the new file's own path.
`MAKE_REG` alone lets a command create an empty file and nothing more: `printf hi > dir/new`
creates `new` and then fails with `Permission denied`. A rule cannot target a file that
does not exist yet, so the only way to allow writing new files is to grant `WRITE_FILE` on
the directory tree. The cost is that existing files under a `dirs` entry are writable as
well. Callers keep `dirs` entries as deep as possible, and the gate's read-back hash diff
still catches any file outside the change set.

### Why a file with several hard links is refused

A Landlock rule on a file is tied to the inode, not the name. Granting `WRITE_FILE` on
`repo/a.txt` therefore also allows writing through any other hard link to it, such as
`outside/a.txt`. The helper refuses a `files` entry whose link count is not 1, exits 121,
and runs nothing. The caller can replace the file with a single-link copy first, or leave it
out of the boundary.

## What the kernel enforces

The helper handles every file-system write right the running ABI supports:
- `WRITE_FILE`, `REMOVE_DIR`, `REMOVE_FILE`, and `MAKE_*` (char, dir, reg, sock, fifo, block, sym);
- `REFER` (ABI 2) and `TRUNCATE` (ABI 3);
- from ABI 9, `RESOLVE_UNIX`, which covers connecting to pathname Unix sockets.

It also sets the ABI-6 scopes: one blocks abstract Unix sockets, the other blocks signals to
processes outside the sandbox. Reading, listing, executing, device ioctls and TCP are not
handled, so they stay allowed. That matches the macOS profile, which allows everything except
file writes and Unix-socket connects.

- **`REFER` comes only with `remove`.** A link or rename that moves a file into a different
  directory needs `REFER` on both sides, and the kernel refuses it when the file would gain
  rights in its new directory.
  - Hard-linking an outside file into a granted directory fails with `EXDEV`.
  - Renaming a file out of a `dirs` entry without `remove` fails with `EACCES`.
  - Renaming a file from a `remove` entry to a directory with no grant fails with `EACCES`;
    to an `rw_trees` entry or another `dirs` entry, where it would gain rights, with `EXDEV`.
    `mv` then falls back to copy and delete: into `rw_trees` that works (the copy lands in
    the temp path, as `cp` would put it there), anywhere unlisted it is refused.
  - `rw_trees` never get `REFER`, so nothing is linked or renamed out of a temp path.
- **Symlinks are resolved at open.**
  - Writing through a symlink to an unlisted file is refused.
  - Writing through a symlink to a listed file is allowed, because the listed file is what gets written.
  - Creating a symlink needs `MAKE_SYM`, which only `rw_trees` grant.
- **Files opened before the restriction are not affected.** The helper opens rule paths with `O_PATH | O_CLOEXEC`, and none of them reach the command. The command still inherits stdin, stdout, and stderr as the caller passed them.
- **Unix sockets.**
  - From ABI 6, connecting to an abstract Unix socket that a process outside the sandbox created fails with `EPERM`.
  - From ABI 9, connecting to a pathname socket outside the sandbox (Docker's, for one) is refused.
  - On ABI 3 to 8, Landlock cannot refuse pathname-socket connects, so the helper adds a seccomp filter after `landlock_restrict_self`: `socket(AF_UNIX, …)` and `io_uring_setup` fail with `EPERM`, and so does every 32-bit x86 system call on x86_64. It is the same program as bubblewrap's in `lib/bwrap.mjs` (`seccompFilter`), and a unit test holds the two instruction for instruction. `socketpair` is not filtered, so pipes between a command's own processes work. TCP and DNS lookups over UDP or TCP work; a resolver reached only over a Unix socket would not. If the filter cannot be installed, the helper exits 122 and runs nothing.
- **`no_new_privs`** is set before `landlock_restrict_self`, as Landlock requires of an unprivileged caller, so setuid binaries cannot gain privileges inside.

## Supervision

The helper is the command's parent and a child subreaper (`PR_SET_CHILD_SUBREAPER`). The
kernel reparents an orphaned process to its nearest living subreaper ancestor, so every
process the command starts stays a descendant of the helper, whether it called `setsid`,
double-forked, or made itself a subreaper too. When the command (`/bin/sh`) ends, or when
the helper gets `SIGTERM`, `SIGINT` or `SIGHUP`, the helper:

1. kills every descendant it finds through the parent links in `/proc` with `SIGKILL`;
2. reaps them, and repeats until it has no child left;
3. exits as the command did: with its exit code, or by re-raising the signal that ended the
   command (or the one that ended the run), so the caller sees what it would have seen
   without the supervisor.

The helper forks before it restricts itself, so it is outside the sandbox. From ABI 6 the
signal scope stops the command's processes from signalling it. On ABI 3 to 5 nothing stops
them: a process that kills the helper with `SIGKILL` ends the supervision. The caller's
process-group kill still ends whatever stayed in the group, but a process that left the
group keeps running, under the write grant it started with. An outside `SIGKILL` of the
helper does the same on any ABI, so the gate sends `SIGTERM` first.

## Exit codes

| Code | Meaning | What ran |
|---|---|---|
| command's own | The ruleset was enforced and `/bin/sh -c` ran. | the command |
| 120 | Landlock is missing or disabled, or its ABI is below 3, so truncation cannot be denied. The caller falls back to bwrap. `--abi` exits 120 in the same cases. | nothing |
| 121 | Bad input: malformed or unknown JSON, an empty command, or a path that is relative, not canonical, missing, the wrong kind, or a file with several hard links. | nothing |
| 122 | A Landlock or `prctl` call failed while building or enforcing the ruleset, the socket filter included. | nothing |
| 123 | The ruleset was enforced, but `/bin/sh` could not be executed. | nothing |

Errors go to stderr, prefixed `pair-landlock: `. A command can exit 120 to 123 itself, so
the caller probes with `--abi` before relying on the helper.

## Binaries

`bin/pair-landlock-x86_64-linux` and `bin/pair-landlock-aarch64-linux` are static musl
executables with no runtime dependencies. They are committed because a marketplace install
is a git clone, so nothing else would reach the user's machine.

`SHA256SUMS` lists both. To check them:

```sh
cd plugins/paired-coding/landlock && sha256sum -c SHA256SUMS
```

`sh build.sh` rebuilds both from source in the pinned official Rust image
(`rust:1.99.0-bookworm`, by digest), and needs only Docker. Both targets link with
`rust-lld` against Rust's bundled musl, and the build always runs on `linux/amd64`, which is
emulated on an arm64 machine. The arm64 toolchain produces different bytes from the same
source. CI rebuilds on every change and fails if the result differs from `SHA256SUMS` by
one byte.

## Tests

- `cargo test` holds the unit tests: rights per ABI, `REFER` and `REMOVE_FILE` only with `remove`, input parsing, path checks, the `/proc/<pid>/stat` parent parsing and descendant walk, and the socket filter, run through a small classic-BPF interpreter and compared with `lib/bwrap.mjs`'s instruction for instruction.
- `sh test/live.sh [binary]` runs the live checks against the running kernel, as a non-root user: among them, below ABI 9 a pathname-socket connect fails with `EPERM` while `socketpair`, TCP and DNS lookups still work; `rm`, `mv` and `sed -i` work in a `remove` entry while rename out of it, `rmdir` and symlinks fail; and a `setsid` or double-forked writer stops when the command exits or the helper gets `SIGTERM`.
- `sh test/docker.sh [x86_64|aarch64]` runs `test/live.sh` in `ubuntu:24.04` as uid 1000. It then simulates a kernel without Landlock with a seccomp profile that fails `landlock_create_ruleset` with `ENOSYS`, and checks for exit 120 with nothing run.

CI runs all three on `ubuntu-latest` (x86_64) and `ubuntu-24.04-arm` (aarch64).

## References

- Landlock userspace API: https://docs.kernel.org/userspace-api/landlock.html
- landlock(7): https://man7.org/linux/man-pages/man7/landlock.7.html
- UAPI header: https://github.com/torvalds/linux/blob/master/include/uapi/linux/landlock.h
