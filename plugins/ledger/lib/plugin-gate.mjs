// plugin-gate.mjs — the six-check push gate for a repository of Claude Code plugins (the
// repo-root AGENTS.md test bar, kind-agnostic). It applies when the pushed commit holds
// `plugins/*/hooks/hooks.json` or a root `.claude-plugin/plugin.json`, and only to plugins with a
// file changed between the push's base and its head. For each such plugin, `ledger gate check`
// runs and records six checks as rows of cc_gate_checks (one per commit, plugin and check
// name; a rerun replaces them). The checks read the commit, never the checkout: each plugin is
// checked out of HEAD's tree into a temporary directory (`git read-tree` + `checkout-index`
// against a scratch index), and the row keeps the hash of that plugin tree. An uncommitted
// repair counts for nothing until it is committed; a committed file removed from the checkout
// is still checked and still pushed. At push time the gate discovers plugins in the pushed
// commit's tree, and a row whose tree hash is not that commit's plugin tree is no pass.
//
//   survives   can't break the session: every hook command in hooks.json is spawned once per
//              fault input (empty stdin, malformed JSON, an unknown event, an unwritable state,
//              no config) under an empty HOME and XDG dirs, 5 s each; a non-zero exit, a timeout,
//              or a `deny` / `block` / `continue: false` in its output fails the check, naming
//              the hook and the input.
//   visible    failures are visible: the malformed-JSON and unwritable-state inputs leave at
//              least one line in `<state>/<plugin>/errors.log` (or in `errors.log` under a path
//              the plugin declares in its `state`, resolved into the sandbox) and a
//              `systemMessage` on stdout
//              (SessionEnd has no reader, and Claude Code discards a PreCompact hook's
//              systemMessage, so neither one's message is required; a hook that printed
//              nothing and logged nothing on the unwritable state never reached it, which is
//              not a failure, and so did one that logged nothing there after its healthy run
//              wrote nothing in the directories that input locks, whatever it printed, as
//              recorded by `lib/write-tracker.cjs` preloaded into the hook (a run it cannot
//              follow gets no such pass): the malformed-JSON input is the one every hook must
//              answer);
//              every `test/fixtures/<x>.txt` has an `<x>.unavailable.txt` sibling (the adapter's
//              unavailable path, captured).
//   says       text says what to do when it can't: every `skills/*/SKILL.md` and `agents/*.md`
//              has a heading matching "when this can't"; every deny or block reason literal in
//              `hooks/*.mjs` and `lib/*.mjs` names a command in backticks; in a plugin with
//              hooks (or scenarios), every "How it fails" / "When this can't" section of those
//              texts, README.md and HOW-IT-FAILS.md names an `evals/<x>.scenario.json` that
//              exists.
//   evals      behaviour is proved: `evals/manifest.json` declares, for every event hooks.json
//              registers, the outcomes its handler can return (deny, allow, ask, systemMessage,
//              silent); every declared event × outcome has one `evals/<x>.scenario.json` naming
//              `event`, `expect` and a stdin fixture (`stdin` or `stdinFile`), not a stub; a
//              silent scenario of an event that can fire names a `sibling` that does; a
//              `judge` needs a `session`. Freshness: the newest cc_canary_runs row for the
//              committed plugin tree is a pass (an `unavailable` row passes with its reason: no
//              `claude` is the canary's finding, not the plugin's), and when a scenario is
//              judge-backed that pass is at most 7 days old. No row for the tree fails naming
//              `ledger canary run`.
//   retention  state is declared and pruned: `.claude-plugin/plugin.json` `state` is an array of
//              `{ path, retentionDays, prune }` (`~`, `$HOME`, `$XDG_*`, `$TMPDIR`, `<worktree>`
//              placeholders; retentionDays null = kept by design); a source site that writes
//              outside the worktree (XDG_*, homedir, .local/, mkdtemp, writeFileSync,
//              appendFileSync in hooks/, lib/, scripts/ and the rest, tests excluded) with no
//              `state` field fails naming the site; a write the canary observed
//              (cc_canary_runs.writes) under no declared path fails naming it. Then every
//              declared prune command is run once with `--dry-run` appended (from the plugin
//              directory, CLAUDE_PLUGIN_ROOT set, 60 s): it must exit 0 and end with the
//              plugin-kit contract line, `pruned: <n> file(s), <bytes> bytes freed`; a prune
//              that exits otherwise, prints another last line, or cannot start fails naming it.
//   docs       a release is written down: when the plugin's `.claude-plugin/plugin.json` version
//              differs from the base commit's, `CHANGELOG.md` has a heading for the new version
//              (`## [<ver>]` or `## <ver>`) with text under it, README.md has a release heading
//              for it (`## Changes in <ver>`, `### <ver>`, `### <date> — <ver>`, or the
//              CHANGELOG shapes) with text under it, and the repository root README names the
//              plugin (a table row or bullet starting with its name, or a `## <plugin>`
//              heading; the root README is an index and never names a version). Skipped when
//              the version did not change. The base manifest and the root README are read out
//              of the commits (`git show`), never the checkout.
//
// A plugin with no `hooks/hooks.json` is `skipped` for survives and for evals (unless it has
// scenarios; the other checks still run). The whole run is capped at 60 s: a check that does not start
// before the cap records `fail` with `timeout`. The PreToolUse deny is given only while the
// store can be read; any fault there is an allow with a notice (the review gate's rule). A
// `review waive "<why>"` row for the head lifts this gate as it lifts the review gate.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "./time.mjs";
import { git, gitHead, defaultBase, headState, currentBranch, NotARepository } from "./review.mjs";
import { transaction } from "./db.mjs";
import { canonicalPath, coverageProblems, loadManifest, loadScenarios, readState, registeredEvents, retentionProblems } from "./plugin-evals.mjs";

export const CHECKS = Object.freeze(["survives", "visible", "says", "evals", "retention", "docs"]);
export const OUTCOMES = Object.freeze(["deny", "allow", "ask", "systemMessage", "silent"]);
export const JUDGE_FRESH_DAYS = 7;
export const HOOK_DEADLINE_MS = 5_000;
export const RUN_CAP_MS = 60_000;
/** The deny reason's and a row's detail are cut here. */
export const DETAIL_MAX = 2_000;
const SESSION_ID = "s-gate-check";
/** Preloaded into every spawned hook (`NODE_OPTIONS=--require`); it logs the paths the run tried to write. */
export const WRITE_TRACKER = fileURLToPath(new URL("./write-tracker.cjs", import.meta.url));

/**
 * The five fault inputs, kind-agnostic. `stdin` is the hook's stdin; `unwritable` makes the
 * plugin's state and data directories read-only (with a writable errors.log already in the
 * state one, so the line can still be written).
 */
/** A well-formed input with nothing wrong: what a hook prints on it is its baseline. */
const HEALTHY_INPUT = Object.freeze({ name: "healthy", visible: false });

export const FAULT_INPUTS = Object.freeze([
  { name: "empty stdin", stdin: "", visible: false },
  { name: "malformed JSON", stdin: "{not json", visible: true },
  { name: "unknown event", event: "NoSuchEvent", visible: false },
  { name: "unwritable state", unwritable: true, visible: true },
  { name: "no config", visible: false },
]);

/**
 * The plugins of commit `sha` in `top`: `{ name, prefix }` each, read from the commit's tree
 * (`git ls-tree`), not the checkout; [] when the commit holds no plugin.
 */
export function treePlugins(top, sha) {
  const files = git(top, ["ls-tree", "-r", "--name-only", sha, "--", "plugins", ".claude-plugin"]).split("\n").filter(Boolean);
  const names = new Set();
  for (const f of files) {
    const m = /^plugins\/([^/]+)\/(?:hooks\/hooks\.json|\.claude-plugin\/plugin\.json)$/.exec(f);
    if (m) names.add(m[1]);
  }
  const out = [...names].sort().map((name) => ({ name, prefix: `plugins/${name}/` }));
  if (!out.length && files.includes(".claude-plugin/plugin.json")) {
    let name = top.split("/").pop();
    try {
      name = JSON.parse(git(top, ["show", `${sha}:.claude-plugin/plugin.json`])).name || name;
    } catch {
      /* the directory's name */
    }
    out.push({ name, prefix: "" });
  }
  return out;
}

/** The hash of the plugin's tree in commit `sha` (the commit's whole tree for a root plugin). */
export function treeSha(top, sha, prefix) {
  return git(top, ["rev-parse", "--verify", prefix ? `${sha}:${prefix.replace(/\/$/, "")}` : `${sha}^{tree}`]).trim();
}

/**
 * The plugin's tree of commit `sha` checked out into a temporary directory: `{ dir, tree,
 * release }`. A scratch index file keeps the repository's own index and checkout untouched.
 */
export function snapshotTree(top, sha, prefix) {
  const tree = treeSha(top, sha, prefix);
  const root = mkdtempSync(join(tmpdir(), "ledger-gate-tree-"));
  const release = () => rmSync(root, { recursive: true, force: true });
  // Until the snapshot is handed over, any failure removes the root with it.
  try {
    const dir = join(root, "tree");
    mkdirSync(dir);
    const env = { ...process.env, GIT_INDEX_FILE: join(root, "index") };
    for (const args of [
      ["read-tree", tree],
      ["--work-tree", dir, "checkout-index", "-a", "-f"],
    ]) {
      const r = spawnSync("git", args, { cwd: top, env, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
      if (r.error || r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.error?.message ?? (r.stderr || "").trim() ?? `exit ${r.status}`}`);
    }
    return { dir, tree, release };
  } catch (err) {
    release();
    throw err;
  }
}

/** The plugins (of `treePlugins`) with a file changed in base..head (every plugin when base is null: the root commit). */
export function changedPlugins(top, base, head, plugins = treePlugins(top, head)) {
  if (!plugins.length) return [];
  if (!base) return plugins;
  const files = git(top, ["diff", "--name-only", `${base}..${head}`]).split("\n").filter(Boolean);
  return plugins.filter((p) => files.some((f) => f.startsWith(p.prefix)));
}

/** The hook commands of a plugin's hooks.json: `{ event, command, args }`; null when it has none. */
export function hookCommands(pluginDir) {
  const path = join(pluginDir, "hooks", "hooks.json");
  if (!existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  for (const [event, groups] of Object.entries(json.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        if (h.type !== "command" || !h.command) continue;
        const sub = (s) => String(s).replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir);
        out.push({ event, command: sub(h.command), args: (h.args ?? []).map(sub) });
      }
    }
  }
  return out;
}

/** A well-formed hook input for `event` that every hook kind finds its fields in. */
function eventInput(event, cwd) {
  return JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: event,
    prompt_id: "p-gate",
    transcript_path: join(cwd, "no-such-transcript.jsonl"),
    source: "startup",
    reason: "exit",
    prompt: "carry on",
    stop_hook_active: false,
    last_assistant_message: "Done.",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
}

/** The mtime, in seconds, every locked sandbox directory starts with: 2000-01-01T00:00:00Z, a whole second on any tick. */
const BACKDATED = 946684800;

/** One sandbox per spawn: an empty HOME and XDG dirs, read-only for the unwritable input. */
function faultSandbox(pluginName, input, stateDirs = []) {
  const root = mkdtempSync(join(tmpdir(), "ledger-gate-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const data = join(root, "data");
  const config = join(root, "config");
  for (const d of [home, state, data, config]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: state, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp"), CLAUDE_PLUGIN_ROOT: "" };
  mkdirSync(env.TMPDIR);
  // errors.log lives at <state>/<plugin>/ by the contract; a plugin that declares its state
  // elsewhere (`state[].path` in plugin.json, under `~` or an XDG root) is read there too.
  const dirs = [join(state, pluginName), ...stateDirs.map((p) => sandboxPath(p, env)).filter(Boolean)];
  const logs = [];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "errors.log");
    writeFileSync(log, "");
    logs.push(log);
  }
  if (input.unwritable) {
    mkdirSync(join(data, pluginName), { recursive: true });
    chmodSync(join(data, pluginName), 0o555);
    for (const dir of dirs) chmodSync(dir, 0o555);
  }
  const release = () => {
    try {
      chmodSync(join(data, pluginName), 0o755);
      for (const dir of dirs) chmodSync(dir, 0o755);
    } catch {
      /* not made read-only */
    }
    rmSync(root, { recursive: true, force: true });
  };
  // The directories the unwritable input makes read-only: a run that writes nothing in them has
  // nothing the unwritable input can take away.
  const locked = [join(data, pluginName), ...dirs];
  // Each starts with its mtime set back to BACKDATED, so an entry made or removed during the run
  // moves it to now, years away, even where the filesystem keeps a coarse timestamp (a 2 s tick
  // would otherwise hide a change in the tick the sandbox was made in). One utimes per directory.
  for (const dir of locked) {
    try {
      utimesSync(dir, BACKDATED, BACKDATED);
    } catch {
      /* not made (the data directory on a writable input) */
    }
  }
  // Outside every locked directory, so the tracker's own lines are never a write there.
  mkdirSync(join(root, "track"));
  const trackLog = join(root, "track", "writes.log");
  return { root, env, errorsLog: logs[0], errorsLogs: logs, locked, trackLog, release };
}

/** Each of `dirs` as its entry names (null when it does not exist). */
function listing(dirs) {
  return dirs.map((dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return null;
    }
  });
}

/**
 * Each of `dirs` as its modification time in nanoseconds: null when it does not exist, "?" when it
 * could not be read for another reason. A directory's mtime moves on every entry created or
 * removed in it, so a temp or lock file made and deleted inside one run shows; the sandbox sets
 * each locked directory's mtime back to BACKDATED first, so a coarse filesystem tick cannot
 * round the change onto the stamp taken before the run. The write tracker still decides.
 */
function stamps(dirs) {
  return dirs.map((dir) => {
    try {
      return statSync(dir, { bigint: true }).mtimeNs;
    } catch (e) {
      return e?.code === "ENOENT" ? null : "?";
    }
  });
}

/** `p` with its symlinks resolved as far as it exists (`/var/…` and `/private/var/…` agree). */
function resolved(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/**
 * What `lib/write-tracker.cjs` logged for one run: `{ on, why, writes }`. writes are the paths a
 * write was attempted on at, inside or above one of `locked`. on is true only when the process
 * spawned (`pid`) itself loaded the tracker, every child process and worker thread it started
 * loaded it too, and no native addon ran; otherwise why says what was missing.
 */
export function trackedWrites(log, pid, locked) {
  let lines;
  try {
    lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    return { on: false, why: e?.code === "ENOENT" ? "no tracker log" : `tracker log unreadable (${e?.message})`, writes: [] };
  }
  const roots = [...new Set(locked.flatMap((d) => [d, resolved(d)]))];
  const touches = (p) => typeof p === "string" && roots.some((d) => p === d || p.startsWith(`${d}/`) || d.startsWith(`${p}/`));
  const writes = [...new Set(lines.filter((l) => l.kind === "write" && Array.isArray(l.value) && l.value.some(touches)).map((l) => l.value[0]))];
  const loaded = new Set(lines.filter((l) => l.kind === "loaded").map((l) => `${l.pid}:${l.thread ?? 0}`));
  if (!loaded.has(`${pid}:0`)) return { on: false, why: "the hook process did not load the write tracker (not node, or its NODE_OPTIONS replaced)", writes };
  const blind = lines.find((l) => l.kind === "untracked");
  if (blind) return { on: false, why: `the hook ran a ${blind.value}`, writes };
  const child = lines.find((l) => l.kind === "child" && !loaded.has(`${l.value}:0`));
  if (child) return { on: false, why: child.value === null ? "the hook started a child process whose pid is hidden" : `child process ${child.value} did not load the write tracker`, writes };
  const worker = lines.find((l) => l.kind === "worker" && !loaded.has(`${l.pid}:${l.value}`));
  if (worker) return { on: false, why: `worker thread ${worker.value} did not load the write tracker`, writes };
  return { on: true, writes };
}

/** A declared state path (`~/x`, `$XDG_STATE_HOME/x`) inside the sandbox; null when not under a sandbox root. */
export function sandboxPath(declared, env) {
  const c = canonicalPath(declared);
  if (c.startsWith("~/")) return join(env.HOME, c.slice(2).replace(/\*/g, "_"));
  if (c === "~") return env.HOME;
  if (c.startsWith("$TMPDIR/")) return join(env.TMPDIR, c.slice(8).replace(/\*/g, "_"));
  return null;
}

const cut = (s, max = DETAIL_MAX) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Claude Code's cap on a PreCompact hook's plain-text stdout (summary instructions): under this many characters. */
export const PRECOMPACT_TEXT_MAX = 10000;

/**
 * Spawn one hook with one fault input. Returns `{ ok, why, visible, wrote, tracking }`: ok false
 * with why when the session would break; visible true when errors.log gained a line and stdout
 * carries a systemMessage; wrote true when the write tracker recorded a write attempt in a
 * directory the unwritable input locks, or the run left an entry or an errors.log line there, or
 * changed that directory's mtime; false when none of those and the tracker followed the whole run;
 * null (unknown) when nothing showed but the tracker could not follow the run. tracking is
 * `trackedWrites`'s verdict. `baselineWrote` is the healthy run's `wrote`.
 */
export function spawnHook(plugin, hook, input, { env: outer = process.env, cwd, stateDirs = [], baselineStdout = null, baselineWrote = null } = {}) {
  const box = faultSandbox(plugin.name, input, stateDirs);
  try {
    const before = listing(box.locked);
    const stampsBefore = stamps(box.locked);
    const stdin = input.stdin ?? eventInput(input.event ?? hook.event, cwd ?? box.root);
    const preload = `--require "${WRITE_TRACKER.replace(/(["\\])/g, "\\$1")}"`;
    const env = { ...box.env, PATH: outer.PATH ?? box.env.PATH, CLAUDE_PLUGIN_ROOT: plugin.dir, NODE_OPTIONS: [box.env.NODE_OPTIONS, preload].filter(Boolean).join(" "), LEDGER_GATE_TRACK_LOG: box.trackLog };
    const started = Date.now();
    const r = hook.args.length
      ? spawnSync(hook.command, hook.args, { cwd: cwd ?? box.root, env, input: stdin, encoding: "utf8", timeout: HOOK_DEADLINE_MS, killSignal: "SIGKILL" })
      : spawnSync("/bin/sh", ["-c", hook.command], { cwd: cwd ?? box.root, env, input: stdin, encoding: "utf8", timeout: HOOK_DEADLINE_MS, killSignal: "SIGKILL" });
    const ms = Date.now() - started;
    const label = `${hook.event} hook on ${input.name}`;
    if (r.error?.code === "ETIMEDOUT" || (r.signal === "SIGKILL" && ms >= HOOK_DEADLINE_MS)) return { ok: false, why: `${label}: no exit within ${HOOK_DEADLINE_MS / 1000}s` };
    if (r.error) return { ok: false, why: `${label}: could not spawn (${r.error.message})` };
    if (r.status !== 0) return { ok: false, why: `${label}: exit ${r.status ?? `signal ${r.signal}`}${r.stderr?.trim() ? ` (${cut(r.stderr.trim(), 200)})` : ""}` };
    let json = null;
    if (r.stdout.trim()) {
      try {
        json = JSON.parse(r.stdout);
      } catch {
        // Claude Code uses a PreCompact hook's plain stdout (exit 0, under 10,000 characters) as
        // instructions for the compaction summary, so there plain text is an answer, not a crash.
        // Every other event keeps the JSON rule.
        if (hook.event !== "PreCompact") return { ok: false, why: `${label}: stdout is not JSON (${cut(r.stdout.trim(), 200)})` };
        if (r.stdout.length >= PRECOMPACT_TEXT_MAX) return { ok: false, why: `${label}: plain-text stdout is ${r.stdout.length} characters; Claude Code takes PreCompact summary instructions under ${PRECOMPACT_TEXT_MAX}` };
      }
      if (json?.hookSpecificOutput?.permissionDecision === "deny") return { ok: false, why: `${label}: denied` };
      if (json?.decision === "block") return { ok: false, why: `${label}: blocked` };
      if (json?.continue === false) return { ok: false, why: `${label}: stopped the session` };
    }
    let logged = 0;
    for (const log of box.errorsLogs) {
      try {
        logged += readFileSync(log, "utf8").split("\n").filter(Boolean).length;
      } catch {
        /* removed by the hook: no line */
      }
    }
    const hasMessage = typeof json?.systemMessage === "string" && json.systemMessage.trim() !== "";
    // SessionEnd has no reader; Claude Code discards a PreCompact hook's systemMessage.
    const needsMessage = hook.event !== "SessionEnd" && hook.event !== "PreCompact";
    // Unwritable state touched nothing when the hook printed what it prints on a healthy run
    // (its baseline, or nothing) and logged nothing: a hook that needs no state has no fault to show.
    // A healthy run that wrote nothing where the unwritable input locks needs no state there, so
    // the input has nothing to take away, whatever it prints (a clock line differs every second).
    // A healthy run that wrote (baselineWrote true) shows the hook keeps state there, so a silent
    // or identical-output unwritable run is a swallowed fault, not an untouched one. An unknown
    // baseline (null: the tracker could not follow the healthy run) grants no stateless pass.
    const untouched = input.unwritable && logged === 0 && baselineWrote !== true && (!r.stdout.trim() || (baselineStdout !== null && r.stdout === baselineStdout) || baselineWrote === false);
    const after = listing(box.locked);
    const stampsAfter = stamps(box.locked);
    // A create-then-delete leaves the entry list as it was; the tracker records it, and the
    // directory's mtime usually moves too. A timestamp that cannot be read counts as a write.
    const tracking = trackedWrites(box.trackLog, r.pid, box.locked);
    const shown =
      logged > 0 ||
      tracking.writes.length > 0 ||
      after.some((names, i) => names !== null && (before[i] === null || names.some((n) => !before[i].includes(n)))) ||
      stampsAfter.some((t, i) => t === "?" || stampsBefore[i] === "?" || t !== stampsBefore[i]);
    // Nothing showed, but a run the tracker could not follow may still have written: unknown.
    const wrote = shown ? true : tracking.on ? false : null;
    return { ok: true, visible: untouched || (logged > 0 && (hasMessage || !needsMessage)), logged, hasMessage, needsMessage, stdout: r.stdout, wrote, tracking };
  } finally {
    box.release();
  }
}

/** Check 1 and 2's hook half for one plugin; null when the plugin has no hooks.json (skipped). */
function hookChecks(plugin, { env, deadline }) {
  const hooks = hookCommands(plugin.dir);
  if (hooks === null) return null;
  // Declared directories only: a declared file (`kind: "file"`) or a glob is nowhere to put errors.log.
  const stateDirs = readState(plugin.dir).declared.filter((d) => d.kind === "dir" && !d.path.includes("*")).map((d) => d.path);
  const unusedPayload = loadManifest(plugin.dir).manifest?.unusedPayload ?? [];
  const broke = [];
  const invisible = [];
  for (const hook of hooks) {
    // The healthy run's stdout is the baseline the unwritable-state run is compared with.
    const healthy = spawnHook(plugin, hook, HEALTHY_INPUT, { env, stateDirs });
    for (const input of FAULT_INPUTS) {
      if (Date.now() > deadline) return { timeout: true };
      const r = spawnHook(plugin, hook, input, { env, stateDirs, baselineStdout: healthy.ok ? healthy.stdout : null, baselineWrote: healthy.ok ? healthy.wrote : null });
      if (!r.ok) broke.push(r.why);
      // A hook whose manifest says it never reads its payload has no fault to see on malformed JSON.
      else if (input.visible && !r.visible && !(input.name === "malformed JSON" && unusedPayload.includes(hook.event))) {
        const missing = [...(r.logged ? [] : ["no errors.log line"]), ...(r.hasMessage || !r.needsMessage ? [] : ["no systemMessage"])];
        invisible.push(`${hook.event} hook on ${input.name}: ${missing.join(", ")}`);
      }
    }
  }
  return { hooks: hooks.length, broke, invisible };
}

/** Every `test/fixtures/<x>.txt` without an `<x>.unavailable.txt` sibling. */
export function fixturesWithoutUnavailable(pluginDir) {
  const dir = join(pluginDir, "test", "fixtures");
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  return names.filter((n) => n.endsWith(".txt") && !n.endsWith(".unavailable.txt") && !names.includes(n.replace(/\.txt$/, ".unavailable.txt"))).sort();
}

const WHEN_CANT = /^#{1,6}\s.*(?:when (?:this|it) can(?:'|’|no)?t\b|how (?:this|it) fails\b)/im;
const SCENARIO_REF = /evals\/[\w.-]+\.scenario\.json/g;

/** Every `skills/*\/SKILL.md` and `agents/*.md` (relative) without a "When this can't …" heading. */
export function textsWithoutWhenCant(pluginDir) {
  const out = [];
  const skills = join(pluginDir, "skills");
  if (existsSync(skills)) {
    for (const name of readdirSync(skills).sort()) {
      const path = join(skills, name, "SKILL.md");
      if (existsSync(path) && !WHEN_CANT.test(readFileSync(path, "utf8"))) out.push(`skills/${name}/SKILL.md`);
    }
  }
  const agents = join(pluginDir, "agents");
  if (existsSync(agents)) {
    for (const name of readdirSync(agents).sort()) {
      if (name.endsWith(".md") && !WHEN_CANT.test(readFileSync(join(agents, name), "utf8"))) out.push(`agents/${name}`);
    }
  }
  return out;
}

/** The "How it fails" / "When this can't" section of a markdown text: from its heading to the next heading of the same or a higher level; null without one. */
export function failureSection(md) {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => WHEN_CANT.test(l));
  if (i < 0) return null;
  const level = lines[i].match(/^#+/)[0].length;
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    out.push(lines[j]);
  }
  return out.join("\n");
}

/**
 * In a plugin with hooks or scenarios: every `skills/*\/SKILL.md`, `agents/*.md`, README.md and
 * HOW-IT-FAILS.md whose failure section names no `evals/<x>.scenario.json` that exists, or names
 * one that does not. `[{ file, why }]`.
 */
export function sectionsWithoutScenario(pluginDir) {
  const evals = join(pluginDir, "evals");
  const hasScenarios = existsSync(evals) && readdirSync(evals).some((n) => n.endsWith(".scenario.json"));
  if (!hasScenarios && !existsSync(join(pluginDir, "hooks", "hooks.json"))) return [];
  const files = [];
  const skills = join(pluginDir, "skills");
  if (existsSync(skills)) for (const name of readdirSync(skills).sort()) if (existsSync(join(skills, name, "SKILL.md"))) files.push(`skills/${name}/SKILL.md`);
  const agents = join(pluginDir, "agents");
  if (existsSync(agents)) for (const name of readdirSync(agents).sort()) if (name.endsWith(".md")) files.push(`agents/${name}`);
  for (const name of ["README.md", "HOW-IT-FAILS.md"]) if (existsSync(join(pluginDir, name))) files.push(name);
  const out = [];
  for (const file of files) {
    const section = failureSection(readFileSync(join(pluginDir, file), "utf8"));
    if (section === null) continue;
    const refs = [...new Set(section.match(SCENARIO_REF) ?? [])];
    if (!refs.length) {
      out.push({ file, why: "its failure section names no evals/<x>.scenario.json" });
      continue;
    }
    const missing = refs.filter((r) => !existsSync(join(pluginDir, r)));
    if (missing.length) out.push({ file, why: `its failure section names ${missing.join(", ")}, which does not exist` });
  }
  return out;
}

/**
 * The reason literals of `source` that belong to a deny or block: a string or template literal
 * right after `permissionDecisionReason:` or, when `deny`, `block` or `rule:` appears within the
 * five lines up to it, `reason:`. Returns `{ line, text }` for each whose text has no backtick
 * command.
 */
export function reasonsWithoutCommand(source) {
  const lines = source.split("\n");
  const out = [];
  const re = /\b(permissionDecisionReason|reason)\s*:\s*(["'`])/g;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i]))) {
      const key = m[1];
      const quote = m[2];
      const context = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
      if (key === "reason" && !/\b(deny|denied|block|blocked|rule)\b/.test(context)) continue;
      // The literal's text, up to its unescaped closing quote (a template may span lines).
      let text = "";
      let j = i;
      let k = m.index + m[0].length;
      let closed = false;
      while (j < lines.length && !closed) {
        const s = lines[j];
        for (; k < s.length; k++) {
          if (s[k] === "\\") {
            text += s[k] + (s[k + 1] ?? "");
            k++;
            continue;
          }
          if (s[k] === quote) {
            closed = true;
            break;
          }
          text += s[k];
        }
        if (!closed) {
          text += "\n";
          j++;
          k = 0;
        }
      }
      const command = quote === "`" ? /\\`[^`]*\S[^`]*\\`/.test(text) : /`[^`]*\S[^`]*`/.test(text);
      if (!command) out.push({ line: i + 1, text: cut(text.replace(/\s+/g, " ").trim(), 80) });
    }
  }
  return out;
}

/** `hooks/*.mjs` and `lib/*.mjs` (relative, with the line) whose deny or block reason names no command. */
export function reasonsWithoutCommandIn(pluginDir) {
  const out = [];
  for (const sub of ["hooks", "lib"]) {
    const dir = join(pluginDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
      for (const r of reasonsWithoutCommand(readFileSync(join(dir, name), "utf8"))) out.push(`${sub}/${name}:${r.line} "${r.text}"`);
    }
  }
  return out;
}

/**
 * The six checks for one plugin: `[{ name, status, detail }]`. `db` and `tree` feed evals and
 * retention; `docs` (`{ baseVersion, rootReadme }`, the base commit's manifest version and the
 * head commit's root README text, null each when absent) feeds docs, which is skipped without it.
 */
export function checkPlugin(plugin, { env = process.env, deadline = Date.now() + RUN_CAP_MS, db = null, tree = null, now = Date.now(), docs = null } = {}) {
  const rows = [];
  const timedOut = () => ({ status: "fail", detail: "timeout" });
  // 1. survives
  const hooks = hookChecks(plugin, { env, deadline });
  if (hooks === null) {
    rows.push({ name: "survives", status: "skipped", detail: "no hooks/hooks.json" });
  } else if (hooks.timeout) {
    rows.push({ name: "survives", ...timedOut() });
  } else {
    rows.push(hooks.broke.length ? { name: "survives", status: "fail", detail: cut(hooks.broke.join("; ")) } : { name: "survives", status: "pass", detail: `${hooks.hooks} hook(s) × ${FAULT_INPUTS.length} fault inputs` });
  }
  // 2. visible
  if (Date.now() > deadline) rows.push({ name: "visible", ...timedOut() });
  else {
    const missing = fixturesWithoutUnavailable(plugin.dir).map((f) => `test/fixtures/${f} has no ${f.replace(/\.txt$/, ".unavailable.txt")}`);
    const faults = hooks && !hooks.timeout ? hooks.invisible : [];
    const all = [...faults, ...missing];
    rows.push(all.length ? { name: "visible", status: "fail", detail: cut(all.join("; ")) } : { name: "visible", status: "pass", detail: hooks === null ? "no hooks; fixtures have unavailable siblings" : "faults logged with a systemMessage; fixtures have unavailable siblings" });
  }
  // 3. says
  if (Date.now() > deadline) rows.push({ name: "says", ...timedOut() });
  else {
    const texts = textsWithoutWhenCant(plugin.dir).map((t) => `${t} has no "How it fails" or "When this can't" heading`);
    const reasons = reasonsWithoutCommandIn(plugin.dir).map((r) => `${r} names no command`);
    const refs = sectionsWithoutScenario(plugin.dir).map((r) => `${r.file}: ${r.why}`);
    const all = [...texts, ...reasons, ...refs];
    rows.push(all.length ? { name: "says", status: "fail", detail: cut(all.join("; ")) } : { name: "says", status: "pass", detail: "every skill and agent text has the section and names a scenario; every deny reason names a command" });
  }
  // 4. evals
  if (Date.now() > deadline) rows.push({ name: "evals", ...timedOut() });
  else rows.push({ name: "evals", ...evalsCheck(plugin, { db, tree, now }) });
  // 5. retention
  if (Date.now() > deadline) rows.push({ name: "retention", ...timedOut() });
  else rows.push({ name: "retention", ...retentionCheck(plugin, { db, env }) });
  // 6. docs
  if (Date.now() > deadline) rows.push({ name: "docs", ...timedOut() });
  else if (!docs) rows.push({ name: "docs", status: "skipped", detail: "not given a base to compare the version with" });
  else rows.push({ name: "docs", ...docsCheck(plugin, docs) });
  return rows;
}

/** The newest canary row for (plugin, tree); null without one or without a db. */
export function canaryRowFor(db, pluginName, tree) {
  if (!db || !tree) return null;
  return db.prepare("SELECT id, at, status, note, writes FROM cc_canary_runs WHERE plugin = ? AND tree_sha = ? ORDER BY at DESC, id DESC LIMIT 1").get(pluginName, tree) ?? null;
}

/** The writes the canary observed for a plugin, from its newest row that recorded any. */
export function observedWrites(db, pluginName) {
  if (!db) return [];
  const row = db.prepare("SELECT writes FROM cc_canary_runs WHERE plugin = ? AND writes IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1").get(pluginName);
  if (!row) return [];
  try {
    const arr = JSON.parse(row.writes);
    return Array.isArray(arr) ? arr.filter((w) => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/** Check 4: manifest coverage, scenario shape, and a fresh canary row for the committed tree. */
export function evalsCheck(plugin, { db = null, tree = null, now = Date.now() } = {}) {
  const events = registeredEvents(plugin.dir);
  const { manifest, error } = loadManifest(plugin.dir);
  const { scenarios, errors } = loadScenarios(plugin.dir, { manifest, events });
  if (!events.length && !manifest && !scenarios.length) return { status: "skipped", detail: "no hooks/hooks.json and no evals/" };
  const problems = [...(error ? [error] : []), ...coverageProblems({ manifest, scenarios, events }), ...errors];
  if (problems.length) return { status: "fail", detail: cut(problems.join("; ")) };
  const proved = scenarios.length;
  const judged = scenarios.some((s) => s.judge !== undefined);
  if (!tree) return { status: "fail", detail: `${proved} scenario(s) cover the manifest; no committed tree to look a canary row up for` };
  const row = canaryRowFor(db, plugin.name, tree);
  if (!row) return { status: "fail", detail: `${proved} scenario(s) cover the manifest; no canary row for tree ${short(tree)}: run \`ledger canary run --plugins ${plugin.name}\` on this commit` };
  if (row.status === "fail") return { status: "fail", detail: `canary run #${row.id} at ${row.at} failed for tree ${short(tree)}${row.note ? ` (${cut(row.note, 300)})` : ""}` };
  const ageDays = (now - Date.parse(row.at)) / 86_400_000;
  if (judged && row.status !== "pass") return { status: "fail", detail: `a judge-backed scenario needs a passing canary run; #${row.id} at ${row.at} is ${row.status}${row.note ? ` (${cut(row.note, 300)})` : ""}` };
  if (judged && ageDays > JUDGE_FRESH_DAYS) return { status: "fail", detail: `a judge-backed scenario needs a canary pass within ${JUDGE_FRESH_DAYS} days; #${row.id} is ${ageDays.toFixed(1)} days old: run \`ledger canary run --plugins ${plugin.name}\`` };
  const live = row.status === "pass" ? "live pass" : `live unavailable (${cut(row.note ?? "no reason", 200)}); hook scenarios passed offline`;
  return { status: "pass", detail: `${proved} scenario(s) cover ${events.length} event(s); canary #${row.id} at ${row.at}: ${live}` };
}

/** The plugin-kit prune contract's last line (`(dry run)` and `; kept <k>` may follow). */
export const PRUNE_LINE = /^pruned: \d+ file\(s\), \d+ bytes freed\b/;

/**
 * Run one declared prune command with `--dry-run`; null when it exits 0 with the contract line
 * last, else the problem. The prune runs in a throwaway HOME, XDG_{CONFIG,STATE,DATA,CACHE}_HOME
 * and TMPDIR of its own (removed after), with only PATH kept from `env` (the faultSandbox
 * convention), so no LEDGER_DB or other `*_STATE_DIR` / `*_DB` override reaches it: a prune that
 * ignores --dry-run removes nothing real. `timeoutMs` bounds it.
 */
export function dryRunPrune(pluginDir, command, { env = process.env, timeoutMs = 60_000 } = {}) {
  const line = `${command} --dry-run`;
  const root = mkdtempSync(join(tmpdir(), "ledger-gate-prune-"));
  const roots = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp") };
  for (const d of Object.values(roots)) mkdirSync(d, { recursive: true });
  let r;
  try {
    r = spawnSync("/bin/sh", ["-c", line], { cwd: pluginDir, env: { PATH: env.PATH ?? process.env.PATH, ...roots, CLAUDE_PLUGIN_ROOT: pluginDir }, encoding: "utf8", timeout: timeoutMs });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const where = `prune \`${command}\` --dry-run`;
  if (r.error) return `${where}: ${r.error.code === "ETIMEDOUT" ? `no exit within ${timeoutMs} ms` : r.error.message}`;
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  if (r.status !== 0) return `${where} exited ${r.status ?? r.signal}${(r.stderr || r.stdout).trim() ? `: ${(r.stderr || r.stdout).trim().split("\n").pop()}` : ""}`;
  if (!PRUNE_LINE.test(last)) return `${where}: last line is "${last}", not \`pruned: <n> file(s), <bytes> bytes freed\``;
  return null;
}

/** Check 5: the `state` declaration against the source's write sites and the canary's observed writes; every prune runs dry. */
export function retentionCheck(plugin, { db = null, env = process.env, dryRun = dryRunPrune } = {}) {
  const r = retentionProblems(plugin.dir, { observedWrites: observedWrites(db, plugin.name) });
  if (r.problems.length) return { status: "fail", detail: cut(r.problems.join("; ")) };
  if (r.state === undefined) return { status: "pass", detail: "no `state` field; no source site writes outside the worktree" };
  const commands = [...new Set(r.declared.filter((d) => d.prune).map((d) => d.prune))];
  const problems = commands.map((c) => dryRun(plugin.dir, c, { env })).filter(Boolean);
  if (problems.length) return { status: "fail", detail: cut(problems.join("; ")) };
  const kept = r.declared.filter((d) => d.retentionDays === null).length;
  const pruned = r.declared.filter((d) => d.prune).length;
  return { status: "pass", detail: `${r.declared.length} state path(s) declared (${pruned} with a prune, ${kept} kept by design); ${commands.length} prune command(s) ran dry; ${r.sites.length} write site(s) in source` };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * A release heading for `version`, any level: `## [<ver>]` and `## <ver>` (Keep a Changelog
 * and the "Changes" sections), `## Changes in <ver>`, and `### <date> — <ver>`. The version is
 * a whole token: brackets balanced, no pre-release suffix.
 */
export function releaseHeading(version) {
  const v = escapeRe(version);
  return new RegExp(`^#{1,6}[ \\t]+(?:changes in[ \\t]+|\\d{4}-\\d{2}-\\d{2}[ \\t]*[—–-]+[ \\t]*)?(?:\\[${v}\\]|${v}(?!\\]))(?!\\w|\\.\\d|-[0-9A-Za-z])`, "i");
}

/** `md`'s lines, each with whether it sits inside a fenced code block (the fence lines included). */
function linesWithFences(md) {
  let fence = null;
  return md.split("\n").map((text) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (fence === null && m) {
      fence = m[1];
      return { text, code: true };
    }
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return { text, code: true };
    }
    return { text, code: false };
  });
}

/**
 * The text under the first line matching `heading`, up to the next heading of the same or a
 * higher level; null without the heading. Lines inside fenced code blocks are never headings.
 */
export function sectionUnder(md, heading) {
  const lines = linesWithFences(md);
  const i = lines.findIndex((l) => !l.code && heading.test(l.text));
  if (i < 0) return null;
  const level = /^#+/.exec(lines[i].text)[0].length;
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].code ? null : /^(#{1,6})[ \t]/.exec(lines[j].text);
    if (m && m[1].length <= level) break;
    body.push(lines[j].text);
  }
  return body.join("\n");
}

/** `ok` when `md` has a release heading for `version` with text under it, `empty` with none, `missing` without the heading. */
export function releaseEntry(md, version) {
  const section = sectionUnder(md, releaseHeading(version));
  if (section === null) return "missing";
  return section.trim() ? "ok" : "empty";
}

/**
 * Whether the repository README names `pluginName`: a table row (up to three spaces of indent)
 * whose whole first cell is the name once code spans, bold and a link around it are removed, a
 * `-` or `*` bullet starting with the name (bold and linked or not), or a heading whose whole
 * text is the name. The root README is an index: it is never asked for a version.
 */
export function rootReadmeNames(md, pluginName) {
  const name = escapeRe(pluginName);
  const bullet = new RegExp(`^[-*][ \\t]+(?:\\*\\*)?\\[?\`?${name}\`?(?![\\w-])`);
  const names = (text) => {
    if (bullet.test(text)) return true;
    const cell = /^ {0,3}\|([^|]*)(?:\||$)/.exec(text);
    return cell !== null && cellLabel(cell[1]) === pluginName;
  };
  if (linesWithFences(md).some((l) => !l.code && names(l.text))) return true;
  return sectionUnder(md, new RegExp(`^#{1,6}[ \\t]+${name}[ \\t]*$`, "i")) !== null;
}

/** A table cell's text with the bold, link and code-span wrappers around it removed, in any nesting. */
function cellLabel(cell) {
  let label = cell.trim();
  for (let prev = null; prev !== label; ) {
    prev = label;
    label = label
      .replace(/^\*\*(.*)\*\*$/, "$1")
      .replace(/^\[(.*)\]\([^)]*\)$/, "$1")
      .replace(/^`(.*)`$/, "$1")
      .trim();
  }
  return label;
}

/** The `version` string of `<dir>/.claude-plugin/plugin.json`; null when the file, or the field, is not there. */
export function manifestVersion(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** The text of `path` in commit `sha`; null when that commit has no such file. */
export function fileAt(top, sha, path) {
  try {
    return git(top, ["show", `${sha}:${path}`]);
  } catch (err) {
    if (err.gitStatus !== undefined) return null;
    throw err;
  }
}

/** The manifest version of the plugin at `prefix` in commit `sha`; null without one (or without a commit). */
export function manifestVersionAt(top, sha, prefix) {
  if (!sha) return null;
  const text = fileAt(top, sha, `${prefix}.claude-plugin/plugin.json`);
  if (text === null) return null;
  try {
    const v = JSON.parse(text).version;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check 6: a version that differs from the base's is written down. `CHANGELOG.md` and README.md
 * each have a release heading for it with text under it, and the repository README names the
 * plugin (not asked of a root plugin, whose README is the repository's). Skipped when the
 * version is unchanged, or when neither the base nor the head manifest has one; a version the
 * base had and the head dropped fails.
 */
export function docsCheck(plugin, { baseVersion = null, rootReadme = null } = {}) {
  const version = manifestVersion(plugin.dir);
  if (version === null && baseVersion !== null) return { status: "fail", detail: `manifest version missing at head: the base has ${baseVersion}; put a "version" back in .claude-plugin/plugin.json` };
  if (version === null) return { status: "skipped", detail: "no `version` in .claude-plugin/plugin.json" };
  if (version === baseVersion) return { status: "skipped", detail: `version ${version} unchanged since the base` };
  const bump = baseVersion === null ? `version ${version}, new since the base` : `version ${baseVersion} → ${version}`;
  const problems = [];
  const found = [];
  for (const file of ["CHANGELOG.md", "README.md"]) {
    const shapes = file === "CHANGELOG.md" ? `"## [${version}]" (or "## ${version}")` : `"## Changes in ${version}" (or "### ${version}", "### <date> — ${version}")`;
    const path = join(plugin.dir, file);
    if (!existsSync(path)) {
      problems.push(`${file} is missing: add it with a ${shapes} entry`);
      continue;
    }
    const entry = releaseEntry(readFileSync(path, "utf8"), version);
    if (entry === "missing") problems.push(`${file} has no ${shapes} heading`);
    else if (entry === "empty") problems.push(`${file} has nothing under its ${version} heading`);
    else found.push(`${file} has its ${version} entry`);
  }
  if (plugin.prefix === "") found.push("a root plugin: README.md is the repository's");
  else if (rootReadme === null) problems.push(`the repository README.md is not in the commit, so nothing names ${plugin.name}`);
  else if (!rootReadmeNames(rootReadme, plugin.name)) problems.push(`the repository README.md does not name ${plugin.name}: add its row to the plugin table ("| ${plugin.name} | …"), or a bullet starting with "${plugin.name}", or a "## ${plugin.name}" heading (the root README never names a version)`);
  else found.push("the repository README names it");
  if (problems.length) return { status: "fail", detail: cut(`${bump}: ${problems.join("; ")}`) };
  return { status: "pass", detail: `${bump}: ${found.join("; ")}` };
}

/** Replace the rows of (top, head, plugin) with `rows`, each certifying the plugin tree `tree`. */
export function recordChecks(db, dbPath, top, head, pluginName, tree, rows, now = Date.now()) {
  const at = nowIso(now);
  const put = db.prepare("INSERT OR REPLACE INTO cc_gate_checks (cwd, head_sha, plugin, name, status, detail, tree_sha, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  transaction(
    db,
    () => {
      for (const r of rows) put.run(top, head, pluginName, r.name, r.status, r.detail ?? null, tree, at);
    },
    dbPath,
  );
}

/** The rows of (top, head, plugin), in CHECKS order. */
export function checkRows(db, top, head, pluginName) {
  const rows = db.prepare("SELECT name, status, detail, tree_sha, at FROM cc_gate_checks WHERE cwd = ? AND head_sha = ? AND plugin = ?").all(top, head, pluginName);
  return CHECKS.map((name) => rows.find((r) => r.name === name)).filter(Boolean);
}

const short = (sha) => String(sha).slice(0, 8);

/**
 * `ledger gate check [--plugins a,b] [--base <ref>]`: run the six checks on every plugin of
 * HEAD's tree with a change in base..HEAD (or the named ones), each read out of the commit,
 * record the rows with the plugin tree they certify, print them. Exit 0 when every row passes
 * or is skipped, 1 when one fails, 2 when the commit holds no plugin. Uncommitted changes
 * under a checked plugin are named: they were not checked.
 */
export function gateCheck({ db, dbPath, cwd, env = process.env, plugins: only = null, base: baseRef = null, now = Date.now() }) {
  let repo;
  try {
    repo = gitHead(cwd);
  } catch (err) {
    if (err instanceof NotARepository) return { code: 2, text: `gate check: ${err.message}` };
    throw err;
  }
  const { top, head } = repo;
  const all = treePlugins(top, head);
  if (!all.length) return { code: 2, text: `gate check: ${short(head)} holds no plugin (no plugins/*/hooks/hooks.json, no .claude-plugin/plugin.json)` };
  // The base is needed in both modes: it is the commit the docs row compares each version with.
  let base;
  if (baseRef) {
    try {
      base = git(top, ["rev-parse", "--verify", "-q", `${baseRef}^{commit}`]).trim();
    } catch (err) {
      if (err.gitStatus !== undefined) return { code: 1, text: `gate check: --base ${baseRef} is not a commit` };
      throw err;
    }
  } else base = defaultBase(db, top, head, currentBranch(top));
  let chosen;
  if (only) {
    const unknown = only.filter((n) => !all.some((p) => p.name === n));
    if (unknown.length) return { code: 1, text: `gate check: no plugin named ${unknown.join(", ")}; the repository has ${all.map((p) => p.name).join(", ")}` };
    chosen = all.filter((p) => only.includes(p.name));
  } else {
    chosen = changedPlugins(top, base, head, all);
    if (!chosen.length) return { code: 0, text: `gate check: no plugin changed in ${base ? short(base) : "root"}..${short(head)}; nothing to check` };
  }
  const rootReadme = fileAt(top, head, "README.md");
  const deadline = now + RUN_CAP_MS;
  const lines = [`gate check ${short(head)}`];
  let failed = 0;
  for (const plugin of chosen) {
    const snap = snapshotTree(top, head, plugin.prefix);
    let rows;
    try {
      rows = checkPlugin({ name: plugin.name, dir: snap.dir, prefix: plugin.prefix }, { env, deadline, db, tree: snap.tree, now, docs: { baseVersion: manifestVersionAt(top, base, plugin.prefix), rootReadme } });
    } finally {
      snap.release();
    }
    recordChecks(db, dbPath, top, head, plugin.name, snap.tree, rows, now);
    for (const r of rows) {
      if (r.status === "fail") failed++;
      lines.push(`  ${plugin.name.padEnd(16)} ${r.name.padEnd(9)} ${r.status.padEnd(7)} ${r.detail ?? ""}`);
    }
    if (git(top, ["status", "--porcelain", "--", plugin.prefix || "."]).trim()) lines.push(`  ${plugin.name.padEnd(16)} (uncommitted changes under ${plugin.prefix || "the repository"} were not checked; commit them and rerun)`);
  }
  lines.push(failed ? `${failed} check(s) failed; fix and rerun \`ledger gate check\`, or \`ledger review waive "<why>"\` to push anyway` : "every check passed");
  return { code: failed ? 1 : 0, text: lines.join("\n") };
}

/** `gate check [--plugins a,b] [--base <ref>]` → { action, plugins, base } or { error }. */
export function parseGateArgs(tokens) {
  const [action, ...rest] = tokens;
  if (action !== "check") return { error: "usage: gate check [--plugins a,b] [--base <ref>]" };
  const out = { action, plugins: null, base: null };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--plugins" && rest[i + 1]) out.plugins = rest[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (t === "--base" && rest[i + 1]) out.base = rest[++i];
    else return { error: `gate check: unknown argument ${t}` };
  }
  return out;
}

/**
 * The gate's answer for the push targets `[{ top, sha }]` (the review gate's): null when no
 * pushed commit holds a plugin, `{}` to allow, `{ deny }` with the reason. A waived head is
 * allowed. The plugins are the pushed commit's, and a row counts only when it certifies that
 * commit's plugin tree. Faults are the caller's (it allows with a notice).
 */
export function pluginGateDecision(db, targets, { cli = "ledger" } = {}) {
  let applies = false;
  for (const t of targets) {
    if (!t.top) continue;
    const all = treePlugins(t.top, t.sha);
    if (!all.length) continue;
    applies = true;
    if (headState(db, t.top, t.sha).kind === "waived") continue;
    const base = defaultBase(db, t.top, t.sha, currentBranch(t.top));
    for (const plugin of changedPlugins(t.top, base, t.sha, all)) {
      const rows = checkRows(db, t.top, t.sha, plugin.name);
      const wayOut = `run \`${cli} gate check\`, fix, or \`${cli} review waive "<why>"\``;
      if (!rows.length) return { deny: `ledger: plugin gate: ${plugin.name} has no check rows for ${short(t.sha)}; ${wayOut}` };
      const missing = CHECKS.filter((name) => !rows.some((r) => r.name === name));
      if (missing.length) return { deny: `ledger: plugin gate: ${plugin.name}'s rows for ${short(t.sha)} have no ${missing.join(", ")} row (recorded by an older ledger); run \`${cli} gate check\` again, or \`${cli} review waive "<why>"\`` };
      const tree = treeSha(t.top, t.sha, plugin.prefix);
      const other = rows.find((r) => r.tree_sha !== tree);
      if (other) return { deny: `ledger: plugin gate: ${plugin.name}'s rows for ${short(t.sha)} certify tree ${short(other.tree_sha)}, not its tree ${short(tree)}; ${wayOut}` };
      const failed = rows.find((r) => r.status === "fail");
      if (failed) return { deny: `ledger: plugin gate: ${plugin.name} failed ${failed.name}: ${cut(failed.detail ?? "", 600)}; ${wayOut}` };
    }
  }
  return applies ? {} : null;
}

