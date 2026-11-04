// plugin-gate.mjs — the five-check push gate for a repository of Claude Code plugins (the
// repo-root AGENTS.md test bar, kind-agnostic). It applies when the pushed commit holds
// `plugins/*/hooks/hooks.json` or a root `.claude-plugin/plugin.json`, and only to plugins with a
// file changed between the push's base and its head. For each such plugin, `ledger gate check`
// runs and records five checks as rows of cc_gate_checks (one per commit, plugin and check
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
//              (SessionEnd has no reader, so its message is not required; a hook that printed
//              nothing and logged nothing on the unwritable state never reached it, which is
//              not a failure: the malformed-JSON input is the one every hook must answer);
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
//              (cc_canary_runs.writes) under no declared path fails naming it.
//
// A plugin with no `hooks/hooks.json` is `skipped` for survives and for evals (unless it has
// scenarios; the other checks still run). The whole run is capped at 60 s: a check that does not start
// before the cap records `fail` with `timeout`. The PreToolUse deny is given only while the
// store can be read; any fault there is an allow with a notice (the review gate's rule). A
// `review waive "<why>"` row for the head lifts this gate as it lifts the review gate.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowIso } from "./time.mjs";
import { git, gitHead, defaultBase, headState, currentBranch, NotARepository } from "./review.mjs";
import { transaction } from "./db.mjs";
import { canonicalPath, coverageProblems, loadManifest, loadScenarios, readState, registeredEvents, retentionProblems } from "./plugin-evals.mjs";

export const CHECKS = Object.freeze(["survives", "visible", "says", "evals", "retention"]);
export const OUTCOMES = Object.freeze(["deny", "allow", "ask", "systemMessage", "silent"]);
export const JUDGE_FRESH_DAYS = 7;
export const HOOK_DEADLINE_MS = 5_000;
export const RUN_CAP_MS = 60_000;
/** The deny reason's and a row's detail are cut here. */
export const DETAIL_MAX = 2_000;
const SESSION_ID = "s-gate-check";

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
  return { root, env, errorsLog: logs[0], errorsLogs: logs, release };
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

/**
 * Spawn one hook with one fault input. Returns `{ ok, why, visible }`: ok false with why when
 * the session would break; visible true when errors.log gained a line and stdout carries a
 * systemMessage.
 */
export function spawnHook(plugin, hook, input, { env: outer = process.env, cwd, stateDirs = [], baselineStdout = null } = {}) {
  const box = faultSandbox(plugin.name, input, stateDirs);
  try {
    const stdin = input.stdin ?? eventInput(input.event ?? hook.event, cwd ?? box.root);
    const env = { ...box.env, PATH: outer.PATH ?? box.env.PATH, CLAUDE_PLUGIN_ROOT: plugin.dir };
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
        return { ok: false, why: `${label}: stdout is not JSON (${cut(r.stdout.trim(), 200)})` };
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
    const needsMessage = hook.event !== "SessionEnd";
    // Unwritable state touched nothing when the hook printed what it prints on a healthy run
    // (its baseline, or nothing) and logged nothing: a hook that needs no state has no fault to show.
    const untouched = input.unwritable && logged === 0 && (!r.stdout.trim() || (baselineStdout !== null && r.stdout === baselineStdout));
    return { ok: true, visible: untouched || (logged > 0 && (hasMessage || !needsMessage)), logged, hasMessage, needsMessage, stdout: r.stdout };
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
      const r = spawnHook(plugin, hook, input, { env, stateDirs, baselineStdout: healthy.ok ? healthy.stdout : null });
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

/** The five checks for one plugin: `[{ name, status, detail }]`. `db` and `tree` feed evals and retention. */
export function checkPlugin(plugin, { env = process.env, deadline = Date.now() + RUN_CAP_MS, db = null, tree = null, now = Date.now() } = {}) {
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
  else rows.push({ name: "retention", ...retentionCheck(plugin, { db }) });
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

/** Check 5: the `state` declaration against the source's write sites and the canary's observed writes. */
export function retentionCheck(plugin, { db = null } = {}) {
  const r = retentionProblems(plugin.dir, { observedWrites: observedWrites(db, plugin.name) });
  if (r.problems.length) return { status: "fail", detail: cut(r.problems.join("; ")) };
  if (r.state === undefined) return { status: "pass", detail: "no `state` field; no source site writes outside the worktree" };
  const kept = r.declared.filter((d) => d.retentionDays === null).length;
  const pruned = r.declared.filter((d) => d.prune).length;
  return { status: "pass", detail: `${r.declared.length} state path(s) declared (${pruned} with a prune, ${kept} kept by design); ${r.sites.length} write site(s) in source` };
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
 * `ledger gate check [--plugins a,b] [--base <ref>]`: run the five checks on every plugin of
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
  let chosen;
  if (only) {
    const unknown = only.filter((n) => !all.some((p) => p.name === n));
    if (unknown.length) return { code: 1, text: `gate check: no plugin named ${unknown.join(", ")}; the repository has ${all.map((p) => p.name).join(", ")}` };
    chosen = all.filter((p) => only.includes(p.name));
  } else {
    let base;
    if (baseRef) base = git(top, ["rev-parse", "--verify", "-q", `${baseRef}^{commit}`]).trim();
    else base = defaultBase(db, top, head, currentBranch(top));
    chosen = changedPlugins(top, base, head, all);
    if (!chosen.length) return { code: 0, text: `gate check: no plugin changed in ${base ? short(base) : "root"}..${short(head)}; nothing to check` };
  }
  const deadline = now + RUN_CAP_MS;
  const lines = [`gate check ${short(head)}`];
  let failed = 0;
  for (const plugin of chosen) {
    const snap = snapshotTree(top, head, plugin.prefix);
    let rows;
    try {
      rows = checkPlugin({ name: plugin.name, dir: snap.dir }, { env, deadline, db, tree: snap.tree, now });
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
      const tree = treeSha(t.top, t.sha, plugin.prefix);
      const other = rows.find((r) => r.tree_sha !== tree);
      if (other) return { deny: `ledger: plugin gate: ${plugin.name}'s rows for ${short(t.sha)} certify tree ${short(other.tree_sha)}, not its tree ${short(tree)}; ${wayOut}` };
      const failed = rows.find((r) => r.status === "fail");
      if (failed) return { deny: `ledger: plugin gate: ${plugin.name} failed ${failed.name}: ${cut(failed.detail ?? "", 600)}; ${wayOut}` };
    }
  }
  return applies ? {} : null;
}

