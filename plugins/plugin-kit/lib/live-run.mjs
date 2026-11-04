#!/usr/bin/env node
// lib/live-run.mjs — the scenario runner every plugin's `e2e/live-run.sh` hands off to, under the
// canary contract (`ledger canary run`): exit 0 pass, 75 unavailable with the reason on the last
// stdout line, anything else fail; every stdout line is kept as the run's summary.
//
//   node lib/live-run.mjs [--plugin-dir <dir>] [--only a,b] [--no-live] [--model <m>]
//   env: CANARY_PLUGIN, CANARY_TRANSCRIPT, CANARY_TIMEOUT_S (the canary's), LIVE_RUN_MODEL
//        (default haiku), LIVE_RUN_TEMP_HOME=1 (live sessions under a temp HOME; see below).
//
// A plugin declares what its hooks can do in evals/manifest.json (`events`: each registered hook
// event → the outcomes its handler can return, from OUTCOMES) and proves each outcome with one
// evals/<name>.scenario.json:
//
//   { "event": "PreToolUse", "expect": "deny",
//     "stdin": { …the hook's input… } | "stdinFile": "fixtures/x.json",
//     "transcript": [ …jsonl entries… ] | "transcriptFile": "fixtures/x.jsonl"   (→ ${TRANSCRIPT}),
//     "setup": { "files": { "rel-or-~/x": "text" }, "commands": ["sh line"], "env": { "K": "v" } },
//     "before": [ { "event": "PreToolUse", "stdin": {…} } ],      the same hook, earlier inputs
//     "reason": "substring the deny reason / message must carry",
//     "after": { "exists": ["$XDG_STATE_HOME/x"], "absent": ["$XDG_STATE_HOME/y"], "commands": ["sh line that must exit 0"] },
//     "sibling": "other.scenario.json",   required on a silent scenario when the event can fire
//     "session": { "prompt": "…", "allowedTools": ["Read"], "tool": "Write", "maxTurns": 6,
//                  "denyReason": "substring", "stopContext": "substring", "reply": "regex",
//                  "after": { …the live session's own after block; default: the scenario's… } },
//     "judge": "a rubric: after the session above passes, `claude plugin eval` runs the same prompt in its own workspace and grades it",
//     "stub": true }                       the scaffold's marker; the gate fails until it is gone
//
// Strings in stdin, setup, before and after take ${CWD}, ${HOME}, ${PLUGIN_DIR}, ${TRANSCRIPT},
// ${SESSION_ID}, ${XDG_STATE_HOME}, ${XDG_DATA_HOME}, ${XDG_CONFIG_HOME}, ${XDG_CACHE_HOME}.
//
// Two phases. The hook phase needs no model: each scenario gets its own sandbox (an empty HOME,
// XDG dirs and TMPDIR; a `git init`ed work directory; every LEDGER_* and <PLUGIN>_* key of the
// caller's environment dropped), runs its setup and `before` inputs, then the hooks hooks.json
// registers for the event (matcher against tool_name), classifies the combined stdout as one
// outcome and compares it to `expect`. Files left outside the work directory are printed as
// `wrote: <placeholder path>` lines (the canary keeps them; the retention gate row reads them).
// The live phase needs `claude`: one pinned CLI-contract session (a PreToolUse hook answering
// `ask` on Read becomes a denial in headless -p, the run still completes; copied from the newdle
// harness's measured canary), then every scenario with a `session`. Isolation: --setting-sources
// "" (--settings alone still merges the user's skills, MCP servers and plugins), temp XDG dirs
// and TMPDIR, the real HOME (measured on 2.1.318: a temp HOME loses the macOS keychain login and
// every session ends terminal_reason api_error in 0 ms; LIVE_RUN_TEMP_HOME=1 opts into a temp
// HOME seeded with ~/.claude.json and ~/.claude/.credentials.json where the login is a file), and
// --session-id pinned so the on-disk transcript (<config dir>/projects/*/<id>.jsonl) can be
// read: Stop-hook feedback lands there and nowhere in stream-json. The verdict reads result.terminal_reason, never the exit code: api_error and
// max_turns are indeterminate. A model that never attempted `session.tool` is indeterminate,
// never a fail. A judge scenario runs its `session` first, then is graded by `claude plugin eval
// --no-publish --json` over a case.yaml + scaffold.sh written from the scenario inside the
// plugin (`judgeCase`); the verdict reads the JSON, never the exit code (a case that fails to
// load exits 0); an API error or missing binary there is indeterminate.
//
// How it fails: a scenario file that does not parse, names an unregistered event, an outcome not
// in OUTCOMES, no stdin, or is still a stub → `fail` naming the file (the gate says the same
// offline). `claude` missing → the hook phase still runs and prints; exit 75 with the reason
// last. A live session whose result cannot be read → indeterminate. Any fail → exit 1.
// Indeterminate alone never fails the run: with no fail and no live pass, exit 75.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const OUTCOMES = Object.freeze(["deny", "allow", "ask", "systemMessage", "silent"]);
export const UNAVAILABLE_EXIT = 75;
export const HOOK_DEADLINE_MS = 10_000;
export const CLI_CONTRACT_SENTINEL = "LIVE-RUN-CLI-CONTRACT-ASK-SENTINEL";
const SCENARIO_SUFFIX = ".scenario.json";

/** Env keys never passed to a hook or session: the ledger's, and the plugin's own prefix. */
export function scrubEnv(env, pluginName) {
  const own = `${pluginName.toUpperCase().replace(/-/g, "_")}_`;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("LEDGER_") && !k.startsWith(own)));
}

/** The hook's stdout as one outcome of OUTCOMES. */
export function classifyOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return "silent";
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return "silent";
  }
  if (!json || typeof json !== "object") return "silent";
  const decision = json.hookSpecificOutput?.permissionDecision;
  if (decision === "deny" || json.decision === "block" || json.continue === false) return "deny";
  if (decision === "ask") return "ask";
  if (decision === "allow") return "allow";
  if ((typeof json.systemMessage === "string" && json.systemMessage.trim()) || (typeof json.hookSpecificOutput?.additionalContext === "string" && json.hookSpecificOutput.additionalContext.trim())) return "systemMessage";
  return "silent";
}

/** The text a hook's output carries: deny reason, block reason, systemMessage, additionalContext. */
export function outputText(stdout) {
  let json;
  try {
    json = JSON.parse(String(stdout ?? ""));
  } catch {
    return String(stdout ?? "");
  }
  if (!json || typeof json !== "object") return "";
  return [json.hookSpecificOutput?.permissionDecisionReason, json.reason, json.stopReason, json.systemMessage, json.hookSpecificOutput?.additionalContext].filter((s) => typeof s === "string").join("\n");
}

/** The hook commands of hooks.json: `{ event, matcher, command }`; null without the file. */
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
        const command = [sub(h.command), ...(h.args ?? []).map((a) => JSON.stringify(sub(a)))].join(" ");
        out.push({ event, matcher: group.matcher ?? null, command });
      }
    }
  }
  return out;
}

/** The registered events of hooks.json, in order; [] without the file. */
export function registeredEvents(pluginDir) {
  const hooks = hookCommands(pluginDir);
  return hooks ? [...new Set(hooks.map((h) => h.event))] : [];
}

/** evals/manifest.json → { manifest } or { error }. Absent → manifest null. */
export function loadManifest(pluginDir) {
  const path = join(pluginDir, "evals", "manifest.json");
  if (!existsSync(path)) return { manifest: null, path };
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { manifest: null, path, error: "evals/manifest.json is not an object" };
    if (manifest.events !== undefined && (typeof manifest.events !== "object" || Array.isArray(manifest.events))) return { manifest: null, path, error: "evals/manifest.json: events must be an object of event → outcomes" };
    return { manifest, path };
  } catch (err) {
    return { manifest: null, path, error: `evals/manifest.json does not parse (${err.message})` };
  }
}

/**
 * Every evals/<name>.scenario.json, parsed and shape-checked against the manifest and
 * hooks.json: `{ scenarios, errors }`. A scenario with an error is kept (with `error`) so the
 * caller can name it; `errors` repeats them with the file name first.
 */
export function loadScenarios(pluginDir, { manifest = loadManifest(pluginDir).manifest, events = registeredEvents(pluginDir) } = {}) {
  const dir = join(pluginDir, "evals");
  const scenarios = [];
  const errors = [];
  if (!existsSync(dir)) return { scenarios, errors };
  const declared = manifest?.events ?? {};
  const files = readdirSync(dir).filter((n) => n.endsWith(SCENARIO_SUFFIX)).sort();
  for (const file of files) {
    const rel = `evals/${file}`;
    const name = file.slice(0, -SCENARIO_SUFFIX.length);
    let json;
    try {
      json = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      errors.push(`${rel} does not parse (${err.message})`);
      scenarios.push({ name, file: rel, error: `does not parse (${err.message})` });
      continue;
    }
    const s = { name, file: rel, ...json };
    const problems = [];
    if (s.stub === true) problems.push("is an unfilled stub (remove \"stub\": true once its stdin and expect are real)");
    if (typeof s.event !== "string" || !s.event) problems.push("names no event");
    else if (events.length && !events.includes(s.event) && s.event !== "session") problems.push(`names ${s.event}, which hooks/hooks.json does not register`);
    else if (s.event !== "session" && declared[s.event] === undefined) problems.push(`names ${s.event}, which evals/manifest.json does not declare`);
    if (s.event !== "session") {
      if (!OUTCOMES.includes(s.expect)) problems.push(`expect must be one of ${OUTCOMES.join(", ")}, not ${JSON.stringify(s.expect ?? null)}`);
      else if (Array.isArray(declared[s.event]) && !declared[s.event].includes(s.expect)) problems.push(`expects ${s.expect}, which the manifest does not declare for ${s.event}`);
      if (s.stdin === undefined && typeof s.stdinFile !== "string") problems.push("has no stdin fixture (stdin or stdinFile)");
      else if (typeof s.stdinFile === "string" && !existsSync(join(dir, s.stdinFile))) problems.push(`stdinFile ${s.stdinFile} is missing`);
      if (typeof s.transcriptFile === "string" && !existsSync(join(dir, s.transcriptFile))) problems.push(`transcriptFile ${s.transcriptFile} is missing`);
      if (s.expect === "silent" && Array.isArray(declared[s.event]) && declared[s.event].some((o) => o !== "silent")) {
        if (typeof s.sibling !== "string") problems.push("stays silent but names no sibling scenario that fires");
        else if (!files.includes(s.sibling)) problems.push(`names sibling ${s.sibling}, which does not exist`);
      }
    } else if (!s.session) problems.push("is a session scenario with no session");
    if (s.judge !== undefined && !s.session) problems.push("has a judge rubric but no session for it to grade");
    if (s.session !== undefined && (typeof s.session !== "object" || typeof s.session.prompt !== "string")) problems.push("session needs a prompt");
    if (problems.length) {
      s.error = problems.join("; ");
      for (const p of problems) errors.push(`${rel} ${p}`);
    }
    scenarios.push(s);
  }
  return { scenarios, errors };
}

/**
 * The manifest's coverage of hooks.json: every registered event declared with outcomes, every
 * declared (event × outcome) proved by one scenario that is not a stub. Returns the problems.
 */
export function coverageProblems(pluginDir, { manifest, scenarios, events = registeredEvents(pluginDir) } = {}) {
  const out = [];
  if (!manifest) {
    if (events.length) out.push(`evals/manifest.json missing; ${events.join(", ")} ${events.length === 1 ? "has" : "have"} no declared outcomes`);
    return out;
  }
  const declared = manifest.events ?? {};
  for (const event of events) {
    const outcomes = declared[event];
    if (!Array.isArray(outcomes) || !outcomes.length) out.push(`evals/manifest.json declares no outcome for ${event}`);
  }
  for (const [event, outcomes] of Object.entries(declared)) {
    if (events.length && !events.includes(event)) out.push(`evals/manifest.json declares ${event}, which hooks/hooks.json does not register`);
    if (!Array.isArray(outcomes)) continue;
    for (const o of outcomes) {
      if (!OUTCOMES.includes(o)) out.push(`evals/manifest.json declares ${o} for ${event}; outcomes are ${OUTCOMES.join(", ")}`);
      else if (!scenarios.some((s) => !s.error && s.event === event && s.expect === o)) out.push(`no scenario for ${event} × ${o}`);
    }
  }
  return out;
}

const XDG = Object.freeze({ XDG_STATE_HOME: ".local/state", XDG_DATA_HOME: ".local/share", XDG_CONFIG_HOME: ".config", XDG_CACHE_HOME: ".cache" });

/** A sandbox: empty HOME, XDG dirs, TMPDIR, a git-initialised work dir, and the env for a hook. */
export function makeSandbox(pluginName, { env = process.env, pluginDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), `live-run-${pluginName}-`));
  const home = join(root, "home");
  const work = join(root, "work");
  const dirs = { HOME: home, TMPDIR: join(root, "tmp") };
  for (const k of Object.keys(XDG)) dirs[k] = join(root, k.slice(4, -5).toLowerCase());
  for (const d of [...Object.values(dirs), work]) mkdirSync(d, { recursive: true });
  spawnSync("git", ["init", "-q", work], { encoding: "utf8", timeout: 5_000 });
  const sessionId = `s-eval-${pluginName}`;
  const base = scrubEnv(env, pluginName);
  const childEnv = { PATH: base.PATH ?? process.env.PATH, ...dirs, CLAUDE_PLUGIN_ROOT: pluginDir ?? "", CLAUDE_PROJECT_DIR: work };
  const vars = { CWD: work, HOME: home, PLUGIN_DIR: pluginDir ?? "", TRANSCRIPT: join(work, "transcript.jsonl"), SESSION_ID: sessionId, ...Object.fromEntries(Object.keys(XDG).map((k) => [k, dirs[k]])) };
  const roots = [[home, "~"], ...Object.keys(XDG).map((k) => [dirs[k], `$${k}`]), [dirs.TMPDIR, "$TMPDIR"]];
  /** An absolute path under the sandbox in placeholder form; null when outside it. */
  const placeholder = (abs) => {
    for (const [dir, tag] of roots) {
      const rel = relative(dir, abs);
      if (rel && !rel.startsWith("..") && !rel.startsWith("/")) return `${tag}/${rel.split("\\").join("/")}`;
      if (rel === "") return tag;
    }
    return null;
  };
  /** Files a scenario's setup put under the sandbox: theirs, not the hook's; writes() leaves them out. */
  const seeded = new Set();
  const seed = (abs) => { seeded.add(abs); };
  /** Files left under the sandbox outside the work directory, as placeholder paths. */
  const writes = ({ skipClaude = true } = {}) => {
    const out = [];
    const walk = (dir) => {
      let names;
      try {
        names = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (!seeded.has(p)) out.push(p);
      }
    };
    for (const [dir] of roots) walk(dir);
    return out
      .map(placeholder)
      .filter((p) => p && !p.startsWith("$TMPDIR"))
      .filter((p) => !skipClaude || !(p.startsWith("~/.claude/") || p === "~/.claude.json" || p.startsWith("~/.claude.json")))
      .sort();
  };
  const release = () => rmSync(root, { recursive: true, force: true });
  return { root, home, work, env: childEnv, vars, sessionId, placeholder, seed, writes, release };
}

/** `${VAR}` placeholders of `vars` substituted through strings, arrays and objects. */
export function substitute(value, vars) {
  if (typeof value === "string") return value.replace(/\$\{([A-Z_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

/** The hooks registered for `event` whose matcher matches the input's tool_name (no matcher: all). */
export function hooksFor(hooks, event, input) {
  const tool = input && typeof input === "object" ? input.tool_name : undefined;
  return hooks.filter((h) => {
    if (h.event !== event) return false;
    if (!h.matcher) return true;
    if (typeof tool !== "string") return false;
    try {
      return new RegExp(`^(?:${h.matcher})$`).test(tool) || new RegExp(h.matcher).test(tool);
    } catch {
      return h.matcher.split("|").includes(tool);
    }
  });
}

/** Spawn every hook of `event` with `stdin` in the box: `{ outcome, text, stdouts, failures }`. */
export function spawnEvent(hooks, event, stdin, box, { extraEnv = {} } = {}) {
  const input = typeof stdin === "string" ? stdin : JSON.stringify(stdin);
  const parsed = typeof stdin === "string" ? null : stdin;
  const chosen = hooksFor(hooks, event, parsed);
  const stdouts = [];
  const failures = [];
  for (const h of chosen) {
    const r = spawnSync("/bin/sh", ["-c", h.command], { cwd: box.work, env: { ...box.env, ...extraEnv }, input, encoding: "utf8", timeout: HOOK_DEADLINE_MS, killSignal: "SIGKILL" });
    if (r.error) failures.push(`${event} hook could not spawn (${r.error.message})`);
    else if (r.status !== 0) failures.push(`${event} hook exited ${r.status ?? `signal ${r.signal}`}${r.stderr?.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : ""}`);
    else stdouts.push(r.stdout);
  }
  const outcomes = stdouts.map(classifyOutput);
  const rank = ["deny", "ask", "allow", "systemMessage", "silent"];
  const outcome = chosen.length ? rank.find((o) => outcomes.includes(o)) ?? "silent" : null;
  return { outcome, text: stdouts.map(outputText).join("\n"), stdouts, failures, hooks: chosen.length };
}

// A setup.files key: relative to the work directory, or `~/x`, `$XDG_STATE_HOME/x`, `${VAR}/x` into the box.
const setupPath = (key, box) => {
  const p = resolvePlaceholders(key, box);
  return p.startsWith("/") ? p : join(box.work, p);
};

/** `~/x`, `$XDG_STATE_HOME/x` and `${VAR}/x` resolved into the box. */
const resolvePlaceholders = (p, box) => substitute(p.replace(/^~(?=\/|$)/, "${HOME}").replace(/^\$([A-Z_]+)(?=\/|$)/, "${$1}"), box.vars);

/** Run a scenario's `after` block in the box; the first failure's reason, or null. `vars` overrides the box's (the live session's id). */
function afterProblems(scenario, box, extraEnv, vars = box.vars) {
  const at = { ...box, vars };
  for (const p of scenario.after?.exists ?? []) if (!existsSync(resolvePlaceholders(p, at))) return `after: ${p} does not exist`;
  for (const p of scenario.after?.absent ?? []) if (existsSync(resolvePlaceholders(p, at))) return `after: ${p} still exists`;
  for (const line of scenario.after?.commands ?? []) {
    const r = spawnSync("/bin/sh", ["-c", substitute(line, vars)], { cwd: box.work, env: { ...box.env, ...extraEnv }, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    if (r.error || r.status !== 0) return `after: \`${line}\` ${r.error ? `could not run (${r.error.message})` : `exited ${r.status}${(r.stdout + r.stderr).trim() ? `: ${(r.stdout + r.stderr).trim().replace(/\s+/g, " ").slice(0, 300)}` : ""}`}`;
  }
  return null;
}

/**
 * Run one scenario's hook phase in its own sandbox: `{ name, verdict, why, outcome, writes }`.
 * verdict: pass, fail, indeterminate (the event has no hook that matches the input).
 */
export function runHookScenario(scenario, { pluginDir, pluginName = basename(pluginDir), hooks = hookCommands(pluginDir) ?? [], env = process.env } = {}) {
  const name = scenario.name;
  if (scenario.error) return { name, verdict: "fail", why: scenario.error, outcome: null, writes: [] };
  if (scenario.event === "session") return { name, verdict: "indeterminate", why: "session scenario: no hook phase", outcome: null, writes: [] };
  const box = makeSandbox(pluginName, { env, pluginDir });
  try {
    const evalsDir = join(pluginDir, "evals");
    const setup = scenario.setup ?? {};
    for (const [rel, text] of Object.entries(setup.files ?? {})) {
      const path = setupPath(rel, box);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, substitute(String(text), box.vars));
      box.seed(path);
    }
    const extraEnv = substitute(setup.env ?? {}, box.vars);
    const transcript = scenario.transcriptFile ? readFileSync(join(evalsDir, scenario.transcriptFile), "utf8") : Array.isArray(scenario.transcript) ? scenario.transcript.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n" : null;
    if (transcript !== null) writeFileSync(box.vars.TRANSCRIPT, substitute(transcript, box.vars));
    for (const line of setup.commands ?? []) {
      const r = spawnSync("/bin/sh", ["-c", substitute(line, box.vars)], { cwd: box.work, env: { ...box.env, ...extraEnv }, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
      if (r.error || r.status !== 0) return { name, verdict: "fail", why: `setup command \`${line}\` ${r.error ? `could not run (${r.error.message})` : `exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`}`, outcome: null, writes: box.writes() };
    }
    for (const b of scenario.before ?? []) {
      const stdin = b.stdinFile ? readFileSync(join(evalsDir, b.stdinFile), "utf8") : b.stdin;
      const r = spawnEvent(hooks, b.event ?? scenario.event, substitute(stdin, box.vars), box, { extraEnv });
      if (r.failures.length) return { name, verdict: "fail", why: `before: ${r.failures.join("; ")}`, outcome: null, writes: box.writes() };
    }
    const stdin = scenario.stdinFile ? readFileSync(join(evalsDir, scenario.stdinFile), "utf8") : scenario.stdin;
    const r = spawnEvent(hooks, scenario.event, substitute(stdin, box.vars), box, { extraEnv });
    const writes = box.writes();
    if (r.failures.length) return { name, verdict: "fail", why: r.failures.join("; "), outcome: r.outcome, writes };
    if (r.outcome === null) return { name, verdict: "indeterminate", why: `no ${scenario.event} hook matches the input (tool_name ${JSON.stringify(stdin?.tool_name ?? null)})`, outcome: null, writes };
    if (r.outcome !== scenario.expect) return { name, verdict: "fail", why: `expected ${scenario.expect}, got ${r.outcome}${r.text ? ` (${r.text.replace(/\s+/g, " ").slice(0, 200)})` : ""}`, outcome: r.outcome, writes };
    if (typeof scenario.reason === "string" && !r.text.includes(substitute(scenario.reason, box.vars))) return { name, verdict: "fail", why: `the ${r.outcome} text does not carry ${JSON.stringify(scenario.reason)}: ${r.text.replace(/\s+/g, " ").slice(0, 200)}`, outcome: r.outcome, writes };
    const after = afterProblems(scenario, box, extraEnv);
    if (after) return { name, verdict: "fail", why: after, outcome: r.outcome, writes };
    return { name, verdict: "pass", why: `${scenario.event} → ${r.outcome}`, outcome: r.outcome, writes };
  } finally {
    box.release();
  }
}

function hasBinary(name, env) {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { env: { PATH: env.PATH ?? process.env.PATH }, encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

/** The stream-json events of a file, skipping lines that are not JSON. */
export function readStream(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a partial line */
    }
  }
  return out;
}

/** What a session's stream says: the result, the tools attempted, the error tool_results, the reply. */
export function readSession(events) {
  const result = events.find((e) => e.type === "result") ?? null;
  const attempted = [];
  const errors = [];
  let reply = "";
  for (const e of events) {
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === "tool_use") attempted.push({ name: c.name, input: c.input });
        if (c.type === "text") reply += `${c.text}\n`;
      }
    }
    if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === "tool_result" && c.is_error === true) errors.push(Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join(" ") : String(c.content ?? ""));
      }
    }
  }
  const init = events.find((e) => e.type === "system" && e.subtype === "init") ?? null;
  const hookEvents = events.filter((e) => e.type === "system" && /^hook_/.test(e.subtype ?? ""));
  return { result, attempted, errors, reply, init, hookEvents, denials: result?.permission_denials ?? [] };
}

/** The Stop hooks' additionalContext from the on-disk transcript of `sessionId` under `configDir`. */
export function stopContextFrom(configDir, sessionId) {
  const root = join(configDir, "projects");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (!existsSync(f)) continue;
    return readStream(f)
      .filter((e) => e.type === "attachment" && e.attachment?.type === "hook_additional_context" && e.attachment?.hookEvent === "Stop")
      .map((e) => (Array.isArray(e.attachment.content) ? e.attachment.content.join("\n") : String(e.attachment.content ?? "")))
      .join("\n");
  }
  return null;
}

/** Seed a temp HOME with the files the CLI needs to be logged in; never written back. */
function seedHome(home, realHome) {
  for (const rel of [".claude.json", ".claude/.credentials.json"]) {
    const src = join(realHome, rel);
    if (!existsSync(src)) continue;
    const dst = join(home, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try {
      copyFileSync(src, dst);
      chmodSync(dst, 0o600);
    } catch {
      /* the session runs without it */
    }
  }
}

/** One headless session. Returns `{ events, session, code, stderr, streamPath, home }`. */
export function runSession({ pluginDir, pluginName, prompt, allowedTools = ["Read"], maxTurns = 6, model = "haiku", settings = null, env = process.env, extraEnv = {}, timeoutS = 300, box }) {
  const sessionId = randomUUID();
  const tempHome = env.LIVE_RUN_TEMP_HOME === "1";
  const home = tempHome ? box.home : env.HOME ?? homedir();
  if (tempHome) seedHome(box.home, env.HOME ?? homedir());
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const streamPath = join(box.root, `session-${sessionId}.jsonl`);
  const args = ["-p", "--session-id", sessionId, "--output-format", "stream-json", "--verbose", "--include-hook-events", "--setting-sources", "", "--plugin-dir", pluginDir, "--model", model, "--max-turns", String(maxTurns)];
  if (settings) {
    const file = join(box.root, `settings-${sessionId}.json`);
    writeFileSync(file, JSON.stringify(settings));
    args.push("--settings", file);
  }
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  args.push("--", prompt);
  // SHELL pinned: the CLI snapshots $SHELL at startup, and the user's zsh rc writes under the
  // sandbox's XDG_CONFIG_HOME (thefuck's settings.py, measured), which would read as the plugin's.
  const childEnv = { ...scrubEnv(env, pluginName), ...box.env, HOME: home, SHELL: "/bin/sh", CLAUDE_CODE_ENTRYPOINT: "cli", ...extraEnv };
  if (env.CLAUDE_CONFIG_DIR) childEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  delete childEnv.CLAUDE_PLUGIN_ROOT;
  delete childEnv.CLAUDE_PROJECT_DIR;
  const r = spawnSync("claude", args, { cwd: box.work, env: childEnv, encoding: "utf8", timeout: timeoutS * 1000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(streamPath, r.stdout ?? "");
  const events = readStream(streamPath);
  return { sessionId, events, session: readSession(events), code: r.status, signal: r.signal, stderr: r.stderr ?? "", streamPath, home, configDir, timedOut: r.error?.code === "ETIMEDOUT" };
}

const unavailableRe = /not logged in|log in|login|credential|unauthori[sz]ed|api key|authentication|network|ENOTFOUND|ECONNREFUSED|rate limit|overloaded/i;

/** The session's standing: null when it completed, else the indeterminate reason. */
export function sessionProblem(run) {
  if (run.timedOut) return "the session hit the deadline";
  const { result } = run.session;
  if (!result) return `no result event in the stream (exit ${run.code ?? run.signal}; stderr: ${run.stderr.trim().split("\n").pop() ?? ""})`.trim();
  const reason = result.terminal_reason ?? (result.is_error ? "error" : "completed");
  if (reason === "completed" || (reason === "success" && !result.is_error)) return null;
  return `terminal_reason ${reason}${result.is_error && unavailableRe.test(JSON.stringify(result)) ? " (credentials, network or rate limit)" : ""}`;
}

/** The pinned CLI-contract session: an `ask` from a PreToolUse hook on Read becomes a denial, and the run completes. */
export function cliContract({ pluginDir, pluginName, env, model, timeoutS }) {
  const box = makeSandbox(pluginName, { env, pluginDir });
  try {
    writeFileSync(join(box.work, "target.txt"), "first line of target.txt\nsecond line\n");
    const settings = { hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"${CLI_CONTRACT_SENTINEL}: this hook always asks; a denial proves headless -p turns ask into a denial."}}'` }] }] } };
    const run = runSession({ pluginDir, pluginName, prompt: "Use the Read tool to read the file `target.txt` in the current directory, then tell me its first line. Do not use Bash, cat, or any other tool for this; use Read.", allowedTools: ["Read"], maxTurns: 4, model, settings, env, timeoutS, box });
    const problem = sessionProblem(run);
    if (problem) return { verdict: "indeterminate", why: problem, run };
    if (!run.session.attempted.some((t) => t.name === "Read")) return { verdict: "indeterminate", why: "the model never attempted Read (model behaviour, not a contract change)", run };
    if (!run.session.denials.some((d) => d.tool_name === "Read")) return { verdict: "fail", why: `Read was attempted and ask did not become a denial: permission_denials ${JSON.stringify(run.session.denials)}`, run };
    const plugins = run.session.init?.plugins;
    if (Array.isArray(plugins) && plugins.length && !JSON.stringify(plugins).includes(pluginName)) return { verdict: "fail", why: `the init event lists plugins ${JSON.stringify(plugins)} without ${pluginName}`, run };
    return { verdict: "pass", why: "ask on Read became a denial; the run completed; the plugin was loaded", run };
  } finally {
    box.release();
  }
}

/** A scenario's live session: `{ verdict, why, writes }`. */
export function runSessionScenario(scenario, { pluginDir, pluginName, env, model, timeoutS }) {
  const s = scenario.session;
  const box = makeSandbox(pluginName, { env, pluginDir });
  try {
    const extraEnv = substitute(scenario.setup?.env ?? {}, box.vars);
    for (const [rel, text] of Object.entries(scenario.setup?.files ?? {})) {
      const path = setupPath(rel, box);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, substitute(String(text), box.vars));
      box.seed(path);
    }
    for (const line of scenario.setup?.commands ?? []) {
      const r = spawnSync("/bin/sh", ["-c", substitute(line, box.vars)], { cwd: box.work, env: { ...box.env, ...extraEnv }, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
      if (r.error || r.status !== 0) return { verdict: "fail", why: `setup command \`${line}\` ${r.error ? `could not run (${r.error.message})` : `exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`}`, writes: [] };
    }
    const run = runSession({ pluginDir, pluginName, prompt: substitute(s.prompt, box.vars), allowedTools: s.allowedTools ?? ["Read"], maxTurns: s.maxTurns ?? 6, model, env, extraEnv, timeoutS, box });
    const writes = box.writes();
    const problem = sessionProblem(run);
    if (problem) return { verdict: "indeterminate", why: problem, writes };
    const { attempted, denials, errors, reply } = run.session;
    if (s.tool && !attempted.some((t) => t.name === s.tool)) return { verdict: "indeterminate", why: `the model never attempted ${s.tool}`, writes };
    if (scenario.event === "PreToolUse" && s.tool) {
      const denied = denials.some((d) => d.tool_name === s.tool);
      if (scenario.expect === "deny" && !denied) return { verdict: "fail", why: `${s.tool} was attempted and not denied`, writes };
      if (scenario.expect !== "deny" && denied) return { verdict: "fail", why: `${s.tool} was denied: ${JSON.stringify(denials)}`, writes };
    }
    if (s.denyReason && !errors.some((e) => e.includes(s.denyReason))) return { verdict: "fail", why: `no error tool_result carried ${JSON.stringify(s.denyReason)}`, writes };
    if (s.stopContext) {
      const ctx = stopContextFrom(run.configDir, run.sessionId);
      if (ctx === null) return { verdict: "indeterminate", why: `no on-disk transcript for session ${run.sessionId} under ${run.configDir}/projects`, writes };
      if (!ctx.includes(s.stopContext)) return { verdict: "fail", why: `no Stop additionalContext carried ${JSON.stringify(s.stopContext)}`, writes };
    }
    if (s.reply && !new RegExp(s.reply, "i").test(reply)) return { verdict: "fail", why: `the reply does not match /${s.reply}/i: ${reply.replace(/\s+/g, " ").slice(0, 200)}`, writes };
    const after = afterProblems(s.after ? { after: s.after } : scenario, box, extraEnv, { ...box.vars, SESSION_ID: run.sessionId });
    if (after) return { verdict: "fail", why: after, writes };
    return { verdict: "pass", why: "the session completed with the expected outcome", writes };
  } finally {
    box.release();
  }
}

/** The eval's operator-gated tools: granted with --allow-tools when the scenario allows them. */
const GATED_TOOLS = new Set(["Bash", "Write", "Edit", "WebFetch"]);

/**
 * The eval case for a judge scenario: a `case.yaml` (JSON body; YAML 1.2 reads it) in the
 * schema `claude plugin eval` 2.1.318 validates (schema_version, name, context.scaffold_script,
 * execution.{prompt,max_turns,timeout_seconds,allowed_tools,env}, runs, graders[{type: llm,
 * name, criteria}]), plus a `scaffold.sh` that recreates `setup.files` and `setup.commands` in
 * the eval's own workspace (cwd `<eval>/home/cwd`, HOME `<eval>/home`, no XDG_* set). File
 * contents are written verbatim through base64: placeholders inside them are not substituted.
 */
export function judgeCase(scenario, { timeoutS = 300 } = {}) {
  const s = scenario.session;
  const shellPath = (key) => `"${key.replace(/^~(?=\/|$)/, "$HOME").replace(/^\$(XDG_[A-Z]+_HOME)(?=\/|$)/, (_, k) => `\${${k}:-$HOME/${XDG[k]}}`).replace(/\$\{(CWD|HOME)\}/g, (_, k) => (k === "CWD" ? "$PWD" : "$HOME")).replace(/"/g, '\\"')}"`;
  const lines = ["#!/bin/sh", "set -e"];
  for (const [rel, text] of Object.entries(scenario.setup?.files ?? {})) {
    const p = shellPath(rel);
    lines.push(`mkdir -p "$(dirname ${p})"`, `printf '%s' '${Buffer.from(String(text)).toString("base64")}' | base64 -d > ${p}`);
  }
  for (const line of scenario.setup?.commands ?? []) lines.push(line);
  const caseYaml = {
    schema_version: "1.0",
    name: scenario.name,
    context: { scaffold_script: "scaffold.sh" },
    execution: { prompt: s.prompt, max_turns: s.maxTurns ?? 6, timeout_seconds: Math.min(Math.max(1, Math.floor(timeoutS)), 3600), allowed_tools: s.allowedTools ?? ["Read"], env: scenario.setup?.env ?? {} },
    runs: 1,
    graders: [{ type: "llm", name: "rubric", criteria: scenario.judge }],
  };
  const allowTools = (s.allowedTools ?? []).filter((t) => GATED_TOOLS.has(t.replace(/\(.*$/, "")) || t.startsWith("mcp__"));
  return { caseYaml, scaffold: `${lines.join("\n")}\n`, allowTools };
}

/** What the eval's JSON says about `name`: `{ verdict, why }`. Exit codes are not read: a case that fails to load still exits 0. */
export function judgeVerdict(json, name, { stderr = "" } = {}) {
  const last = (t) => t.trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "";
  const c = json?.cases?.find((x) => x.name === name);
  if (!c) return { verdict: "fail", why: `claude plugin eval loaded no case named ${name}: ${last(stderr) || "no JSON result"}` };
  const run = Object.values(c.arms ?? {}).flat()[0];
  if (!run) return { verdict: "indeterminate", why: "claude plugin eval recorded no run for the case" };
  if (run.error) return { verdict: unavailableRe.test(run.error) || /api[ _-]?error/i.test(run.error) ? "indeterminate" : "fail", why: `claude plugin eval: ${String(run.error).replace(/\s+/g, " ").slice(0, 300)}` };
  const g = run.graders?.[0];
  const votes = g?.explanation ? ` (${g.explanation})` : "";
  if (run.passed) return { verdict: "pass", why: `claude plugin eval: the rubric passed${votes}` };
  return { verdict: "fail", why: `claude plugin eval: the rubric failed${votes}: ${String(g?.evidence ?? "").replace(/\s+/g, " ").slice(0, 300)}` };
}

/**
 * A judge scenario: the deterministic session first (`runSessionScenario`), then the rubric,
 * graded by `claude plugin eval` over a case written from the scenario (see `judgeCase`).
 * `{ verdict, why, writes }`: a fail on either side fails; the judge's API error, missing
 * binary or load failure is indeterminate, never a pass.
 */
export function judgeScenario(scenario, { pluginDir, pluginName, env, model, timeoutS, session = runSessionScenario }) {
  const first = session(scenario, { pluginDir, pluginName, env, model, timeoutS });
  if (first.verdict !== "pass") return { ...first, why: `session: ${first.why}` };
  const box = makeSandbox(pluginName, { env, pluginDir });
  // `--eval-dir` must be a relative path inside the plugin (claude 2.1.318 refuses an absolute
  // one), so the case is written under the plugin and removed in `finally`, whatever happens.
  const casesRel = `live-run-cases-${process.pid}`;
  const cases = join(pluginDir, casesRel);
  try {
    const { caseYaml, scaffold, allowTools } = judgeCase(scenario, { timeoutS });
    const caseDir = join(cases, scenario.name);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "case.yaml"), `${JSON.stringify(caseYaml, null, 2)}\n`);
    writeFileSync(join(caseDir, "scaffold.sh"), scaffold, { mode: 0o755 });
    const out = join(box.root, "eval.json");
    const args = ["plugin", "eval", pluginDir, "--eval-dir", casesRel, "--no-publish", "--trust-plugin", "--scaffold", "--runs", "1", "--ablation", "none", "--output-dir", join(box.root, "eval-out"), "--report", join(box.root, "report.html"), "--json", out];
    if (allowTools.length) args.push("--allow-tools", ...allowTools);
    const r = spawnSync("claude", args, { cwd: box.work, env: { ...scrubEnv(env, pluginName), HOME: env.HOME ?? homedir() }, encoding: "utf8", timeout: timeoutS * 1000 + 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { verdict: "indeterminate", why: `claude plugin eval could not run (${r.error.message})`, writes: first.writes };
    let json = null;
    try {
      json = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      /* no file: the stderr says why */
    }
    if (!json) {
      const text = `${r.stdout}\n${r.stderr}`;
      const why = `claude plugin eval exit ${r.status ?? r.signal} without a JSON result: ${text.trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? ""}`;
      return { verdict: unavailableRe.test(text) || /api[ _-]?error/i.test(text) ? "indeterminate" : "fail", why, writes: first.writes };
    }
    return { ...judgeVerdict(json, scenario.name, { stderr: r.stderr ?? "" }), writes: first.writes };
  } finally {
    rmSync(cases, { recursive: true, force: true });
    box.release();
  }
}

/** Parse the CLI's arguments. */
export function parseArgs(argv, env = process.env) {
  const out = { pluginDir: null, only: null, live: true, model: env.LIVE_RUN_MODEL ?? "haiku" };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--plugin-dir" && argv[i + 1]) out.pluginDir = resolve(argv[++i]);
    else if (t === "--only" && argv[i + 1]) out.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (t === "--no-live") out.live = false;
    else if (t === "--model" && argv[i + 1]) out.model = argv[++i];
    else return { error: `live-run: unknown argument ${t}` };
  }
  if (!out.pluginDir) out.pluginDir = process.cwd();
  return out;
}

/**
 * The whole run: `{ code, lines }`. Prints nothing itself; `main` does. `claudePresent` and the
 * live runners are injectable for tests.
 */
export function run({ pluginDir, only = null, live = true, model = "haiku", env = process.env, claudePresent = null, contract = cliContract, session = runSessionScenario, judge = judgeScenario, timeoutS = Number(env.CANARY_TIMEOUT_S) || 300 }) {
  const pluginName = env.CANARY_PLUGIN || basename(pluginDir);
  const lines = [`${pluginName} live-run: plugin ${pluginDir}`];
  const { manifest, error: manifestError } = loadManifest(pluginDir);
  const events = registeredEvents(pluginDir);
  const hooks = hookCommands(pluginDir) ?? [];
  const { scenarios } = loadScenarios(pluginDir, { manifest, events });
  let failed = 0;
  if (manifestError) {
    lines.push(`fail: ${manifestError}`);
    failed++;
  }
  for (const p of coverageProblems(pluginDir, { manifest, scenarios, events })) {
    lines.push(`fail: ${p}`);
    failed++;
  }
  const chosen = only ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
  const writes = new Set();
  let hookPasses = 0;
  for (const s of chosen) {
    const r = runHookScenario(s, { pluginDir, pluginName, hooks, env });
    for (const w of r.writes) writes.add(w);
    if (r.verdict === "fail") failed++;
    if (r.verdict === "pass") hookPasses++;
    lines.push(`scenario ${s.name}: ${r.verdict}${r.why ? ` — ${r.why}` : ""}`);
  }
  const hasClaude = claudePresent ?? hasBinary("claude", env);
  let livePasses = 0;
  let indeterminate = 0;
  if (live && hasClaude) {
    const c = contract({ pluginDir, pluginName, env, model, timeoutS });
    lines.push(`cli-contract: ${c.verdict} — ${c.why}`);
    if (c.verdict === "fail") failed++;
    else if (c.verdict === "pass") livePasses++;
    else indeterminate++;
    for (const s of chosen.filter((x) => x.session && !x.error)) {
      const r = s.judge ? judge(s, { pluginDir, pluginName, env, model, timeoutS, session }) : session(s, { pluginDir, pluginName, env, model, timeoutS });
      for (const w of r.writes ?? []) writes.add(w);
      lines.push(`session ${s.name}: ${r.verdict} — ${r.why}`);
      if (r.verdict === "fail") failed++;
      else if (r.verdict === "pass") livePasses++;
      else indeterminate++;
    }
  }
  for (const w of [...writes].sort()) lines.push(`wrote: ${w}`);
  if (failed) {
    lines.push(`fail: ${failed} problem(s); ${hookPasses} hook scenario(s) passed, ${livePasses} live pass(es), ${indeterminate} indeterminate`);
    return { code: 1, lines };
  }
  if (!live) {
    lines.push(`unavailable: live phase skipped (--no-live); ${hookPasses} hook scenario(s) passed offline`);
    return { code: UNAVAILABLE_EXIT, lines };
  }
  if (!hasClaude) {
    lines.push(`unavailable: claude not found on PATH; ${hookPasses} hook scenario(s) passed offline`);
    return { code: UNAVAILABLE_EXIT, lines };
  }
  if (!livePasses) {
    lines.push(`unavailable: every live session was indeterminate (${indeterminate}); ${hookPasses} hook scenario(s) passed offline`);
    return { code: UNAVAILABLE_EXIT, lines };
  }
  lines.push(`pass: ${hookPasses} hook scenario(s), ${livePasses} live pass(es), ${indeterminate} indeterminate`);
  return { code: 0, lines };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.error) {
    process.stdout.write(`${args.error}\n`);
    return 1;
  }
  const r = run({ ...args, env });
  process.stdout.write(`${r.lines.join("\n")}\n`);
  if (env.CANARY_TRANSCRIPT) {
    try {
      mkdirSync(dirname(env.CANARY_TRANSCRIPT), { recursive: true });
      writeFileSync(env.CANARY_TRANSCRIPT, `${r.lines.map((l) => JSON.stringify({ type: "live-run", line: l })).join("\n")}\n`);
    } catch {
      /* the stdout is the record */
    }
  }
  return r.code;
}

export function invokedDirectly(url) {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url)) main().then((code) => process.exit(code));
