// write-tracker.cjs — preloaded (`NODE_OPTIONS=--require`) into every hook `gate check` spawns, so
// the gate knows which paths a run tried to write instead of guessing from what the directories
// look like afterwards. It wraps the write entry points of `fs`, `fs/promises` and their callback
// forms, and appends one JSON line per attempt to `$LEDGER_GATE_TRACK_LOG`, using the unwrapped
// `appendFileSync`. Nothing is blocked and nothing is printed: the hook runs as it would without it.
//
// Lines: `loaded` (this process or worker thread carries the tracker; `thread` is its threadId),
// `write` (a path a write was attempted on, before the call, so a failed or create-then-delete
// write still shows), `child` (a spawned process and its pid, or null when the API hides it),
// `worker` (a worker thread's threadId), `untracked` (a native addon, whose writes this file cannot
// see). The gate trusts a run's record only when the spawned process itself logged `loaded`, every
// child pid and worker thread logged `loaded` too, and nothing was untracked.
"use strict";

const LOG = process.env.LEDGER_GATE_TRACK_LOG;
if (LOG) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { fileURLToPath } = require("node:url");
  const { syncBuiltinESMExports } = require("node:module");
  const { threadId } = require("node:worker_threads");
  const append = fs.appendFileSync;
  const existsSync = fs.existsSync;
  const realpathSync = fs.realpathSync;
  const readlinkSync = fs.readlinkSync;

  // appendFileSync opens its file through the exported (wrapped) openSync: without this guard each
  // line it writes would be recorded as a write, and that record written, without end.
  let busy = false;
  const record = (kind, value) => {
    if (busy) return;
    busy = true;
    try {
      append(LOG, `${JSON.stringify({ pid: process.pid, ppid: process.ppid, thread: threadId, kind, value })}\n`);
    } catch {
      /* the log is the gate's; a hook never fails for it */
    } finally {
      busy = false;
    }
  };
  const resolve = (p) => {
    try {
      if (p instanceof URL) p = fileURLToPath(p);
      else if (Buffer.isBuffer(p)) p = p.toString();
      if (typeof p !== "string") return null;
      return path.resolve(p);
    } catch {
      return null;
    }
  };
  // The path as given (made absolute) and with its parent's symlinks resolved, so /var and /private/var
  // agree. With `follow`, for an entry point that writes through a symlink at the path, also the file it
  // resolves to: a link elsewhere to a state file is a write to that state file.
  const wrote = (p, follow) => {
    const abs = resolve(p);
    if (abs === null) return;
    const paths = [abs];
    try {
      paths.push(path.join(realpathSync(path.dirname(abs)), path.basename(abs)));
    } catch {
      /* the parent does not exist yet */
    }
    if (follow) {
      try {
        paths.push(realpathSync(abs));
      } catch {
        // Nothing there yet, or a dangling link (a write through it creates its target).
        const target = finalTarget(abs);
        if (target !== null) paths.push(target);
      }
    }
    record("write", [...new Set(paths)]);
  };
  // Where a chain of links ending at a missing file points: each hop read with readlink (relative
  // targets against the link's real directory), at most 40 hops, then the last parent resolved.
  // Runs only when realpath failed; null when even that walk fails.
  const finalTarget = (abs) => {
    try {
      let p = abs;
      for (let hops = 0; hops < 40; hops++) {
        let next;
        try {
          next = readlinkSync(p);
        } catch {
          break;
        }
        p = path.resolve(realDir(path.dirname(p)), next);
      }
      return path.join(realDir(path.dirname(p)), path.basename(p));
    } catch {
      return null;
    }
  };
  const realDir = (d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  };
  const WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  const writesFlags = (flags) => (flags == null ? false : typeof flags === "number" ? (flags & WRITE_BITS) !== 0 : /[wa+]/.test(String(flags)));
  const isFd = (p) => typeof p === "number" || (p && typeof p === "object" && typeof p.fd === "number");
  const lstatSync = fs.lstatSync;
  // A removal counts only when there is something to remove: `rm(f, { force: true })` on a missing
  // file changes nothing, and a create-then-delete has its create recorded anyway.
  const present = (p) => {
    const abs = resolve(p);
    if (abs === null) return [];
    try {
      lstatSync(abs);
      return [p];
    } catch {
      return [];
    }
  };

  // Which arguments of each entry point name a path written to. `mkdir` counts only when the target
  // did not exist: a recursive mkdir of an existing directory changes nothing; a removal only when
  // it did.
  // The entry points that write through a symlink to its target. The rest act on the link itself
  // (unlink, rm, rename, symlink, lchown, ...), or create the path (mkdir, mkdtemp, link).
  const FOLLOWS = new Set(["writeFile", "appendFile", "open", "copyFile", "cp", "truncate", "chmod", "chown", "utimes", "createWriteStream"]);
  const SPEC = {
    writeFile: (a) => (isFd(a[0]) ? [] : [a[0]]),
    appendFile: (a) => (isFd(a[0]) ? [] : [a[0]]),
    open: (a) => (writesFlags(a[1]) ? [a[0]] : []),
    mkdir: (a) => {
      const abs = resolve(a[0]);
      return abs !== null && !existsSync(abs) ? [a[0]] : [];
    },
    mkdtemp: (a) => [a[0]],
    rename: (a) => [a[0], a[1]],
    unlink: (a) => present(a[0]),
    rm: (a) => present(a[0]),
    rmdir: (a) => present(a[0]),
    copyFile: (a) => [a[1]],
    cp: (a) => [a[1]],
    link: (a) => [a[1]],
    symlink: (a) => [a[1]],
    truncate: (a) => (isFd(a[0]) ? [] : [a[0]]),
    chmod: (a) => [a[0]],
    lchmod: (a) => [a[0]],
    chown: (a) => [a[0]],
    lchown: (a) => [a[0]],
    utimes: (a) => [a[0]],
    lutimes: (a) => [a[0]],
  };
  const wrap = (target, name, spec, follow = FOLLOWS.has(name)) => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      try {
        for (const p of spec(args)) wrote(p, follow);
      } catch {
        /* never in the hook's way */
      }
      return original.apply(this, args);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    target[name] = wrapped;
  };
  for (const [name, spec] of Object.entries(SPEC)) {
    wrap(fs, name, spec);
    wrap(fs, `${name}Sync`, spec, FOLLOWS.has(name));
    wrap(fs.promises, name, spec);
  }
  wrap(fs, "createWriteStream", (a) => [a[0]]);

  const cp = require("node:child_process");
  const { promisify } = require("node:util");
  for (const name of ["spawn", "fork", "exec", "execFile"]) {
    const original = cp[name];
    const wrapped = function (...args) {
      const child = original.apply(this, args);
      record("child", child?.pid ?? null);
      return child;
    };
    // exec and execFile carry their own promisified form, which resolves to { stdout, stderr } and
    // calls the unwrapped function: keep it, and record its child from the promise's `child`.
    const custom = original[promisify.custom];
    if (typeof custom === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        configurable: true,
        value: function (...args) {
          const promise = custom.apply(this, args);
          record("child", promise?.child?.pid ?? null);
          return promise;
        },
      });
    }
    cp[name] = wrapped;
  }
  const spawnSync = cp.spawnSync;
  cp.spawnSync = function (...args) {
    const r = spawnSync.apply(this, args);
    record("child", r?.pid ?? null);
    return r;
  };
  // These return the output only, so the child's pid, and whether it carried the tracker, is unknown.
  for (const name of ["execSync", "execFileSync"]) {
    const original = cp[name];
    cp[name] = function (...args) {
      record("child", null);
      return original.apply(this, args);
    };
  }

  const dlopen = process.dlopen;
  process.dlopen = function (...args) {
    record("untracked", "native addon");
    return dlopen.apply(this, args);
  };
  // A worker thread loads this preload too, with its own fs, and logs its own `loaded`.
  const wt = require("node:worker_threads");
  const Worker = wt.Worker;
  wt.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      record("worker", this.threadId ?? null);
    }
  };

  // ESM named imports of builtins (`import { writeFileSync } from "node:fs"`) read these bindings.
  syncBuiltinESMExports();
  record("loaded", process.argv[1] ?? null);
}
