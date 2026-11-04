#!/usr/bin/env node
// scripts/new-plugin.mjs — scaffold a plugin that meets the repository test bar on day one.
//
//   node scripts/new-plugin.mjs <name> --events PreToolUse,Stop[,…] [--description "…"] [--dest <plugins dir>] [--judge]
//   (run it from inside the repository the plugin is for)
//
// Writes <dest>/<name>/ from templates/ (default dest: the `plugins/` of the git repository the
// cwd is in, found with `git rev-parse --show-toplevel`; a cwd in no repository is refused
// naming --dest: the kit's own checkout, or the marketplace cache it is installed from, is
// never the destination), with
// {{name}}, {{title}}, {{description}}, and per hook {{event}}, {{file}}, {{quiet}} filled in:
//
//   .claude-plugin/plugin.json     with a `state` declaration ($XDG_STATE_HOME/<name>, 30 days, scripts/prune.mjs)
//   package.json, README.md (with its `## Changes in 0.1.0`), CHANGELOG.md (Keep a Changelog, a 0.1.0 entry), HOW-IT-FAILS.md
//   lib/hook-runner.mjs            a COPY of plugin-kit/lib/hook-runner.mjs (the plugin owns it)
//   lib/live-run.mjs               a COPY of plugin-kit/lib/live-run.mjs (the scenario runner)
//   lib/judge.mjs                  with --judge: a COPY of plugin-kit/lib/judge.mjs (the shared judge
//                                  dispatch; the kit's test/judge.test.mjs diffs every shipped copy)
//   hooks/hooks.json               one entry per event, `node "${CLAUDE_PLUGIN_ROOT}/hooks/<event>.mjs"`, timeout 5
//   hooks/<event>.mjs              one handler per event, returning null (allow) until a rule is written
//   skills/<name>/SKILL.md         with the "When this can't run" section, naming a scenario file
//   evals/manifest.json            each event → ["silent"] until the handler does more
//   evals/<event>.scenario.json    one stub per event ("stub": true; `ledger gate check` fails until it is filled)
//   scripts/prune.mjs              the retention verb the `state` declaration names
//   test/hook-contract.test.mjs    the five fault inputs, per hook
//   test/fixtures/README.md        the <x>.txt / <x>.unavailable.txt sibling rule
//   e2e/live-run.sh                the canary contract (exit 0 pass, 75 unavailable, stdout kept), handing off to lib/live-run.mjs
//
// Refuses: a name that is not lowercase kebab, an event not in the host's list, an existing
// destination (nothing is overwritten; delete it yourself first), no events. Exit 1 with the
// reason on stderr; exit 0 with the written paths on stdout. Two repository-root files are not
// written: the root README's row for the plugin (its name and one sentence; add it by hand
// before the first `ledger gate check`; its docs row fails a new plugin without it; the root
// README never names a version), and the marketplace entry (.claude-plugin/marketplace.json;
// add it by hand, with the same one-sentence description, when the plugin is ready to publish).

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATES = join(KIT_ROOT, "templates");
/** Claude Code's hook events, with the matcher the handler template is written for. */
export const EVENTS = Object.freeze({
  PreToolUse: { matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit" },
  PostToolUse: { matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit" },
  PermissionRequest: { matcher: "" },
  UserPromptSubmit: { matcher: null },
  Stop: { matcher: null },
  SubagentStop: { matcher: null },
  SessionStart: { matcher: null },
  SessionEnd: { matcher: null, quiet: true },
  PreCompact: { matcher: null },
  Notification: { matcher: null },
});
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const kebab = (event) => event.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const title = (name) => name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/** The git toplevel `cwd` is in, or null (no repository, or git missing or slow). */
export function repoTop(cwd) {
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    return !r.error && r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** A well-formed hook input for `event`, the shape the scenario stub starts from. */
export function sampleInput(event) {
  const base = { session_id: "${SESSION_ID}", transcript_path: "${TRANSCRIPT}", cwd: "${CWD}", hook_event_name: event };
  if (event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest") return { ...base, tool_name: "Write", tool_input: { file_path: "${CWD}/notes.txt", content: "hello" } };
  if (event === "UserPromptSubmit") return { ...base, prompt: "hello" };
  if (event === "Stop" || event === "SubagentStop") return { ...base, stop_hook_active: false };
  if (event === "SessionStart") return { ...base, source: "startup" };
  if (event === "SessionEnd") return { ...base, reason: "other" };
  if (event === "PreCompact") return { ...base, trigger: "manual" };
  if (event === "Notification") return { ...base, message: "hello" };
  return base;
}

export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const [name, ...rest] = argv;
  const out = { name, events: [], description: "", dest: null, judge: false };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--events" && rest[i + 1]) out.events = rest[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (t === "--description" && rest[i + 1]) out.description = rest[++i];
    else if (t === "--dest" && rest[i + 1]) out.dest = rest[++i];
    else if (t === "--judge") out.judge = true;
    else return { error: `unknown argument ${t}` };
  }
  if (!name || name.startsWith("--")) return { error: "usage: new-plugin.mjs <name> --events A,B [--description …] [--dest <plugins dir>] [--judge]" };
  if (!NAME_RE.test(name)) return { error: `name must be lowercase kebab (a-z, 0-9, hyphens between words), not ${JSON.stringify(name)}` };
  if (!out.events.length) return { error: "--events names at least one hook event" };
  const unknown = out.events.filter((e) => !EVENTS[e]);
  if (unknown.length) return { error: `unknown event ${unknown.join(", ")}; the events are ${Object.keys(EVENTS).join(", ")}` };
  if (!out.description) out.description = `(one sentence: what ${name} does for the person, and the rule its hooks enforce)`;
  if (!out.dest) {
    const top = repoTop(cwd);
    if (!top) return { error: `${cwd} is in no git repository; pass --dest <plugins dir> (the new plugin goes under the repository you are adding it to, never beside the kit)` };
    out.dest = join(top, "plugins");
  }
  return out;
}

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** Scaffold. Returns the written paths (relative to the plugin). Throws with the reason. */
export function scaffold({ name, events, description, dest, judge = false }) {
  const root = join(dest, name);
  if (existsSync(root)) throw new Error(`${root} exists; nothing was written`);
  const vars = { name, title: title(name), description: description.replace(/"/g, '\\"') };
  const written = [];
  const put = (rel, text, mode) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { flag: "wx" });
    if (mode) chmodSync(path, mode);
    written.push(rel);
  };
  const tpl = (rel) => readFileSync(join(TEMPLATES, rel), "utf8");
  vars.scenario = `evals/${kebab(events[0])}.scenario.json`;
  put(".claude-plugin/plugin.json", fill(tpl(".claude-plugin/plugin.json"), vars));
  put("package.json", fill(tpl("package.json"), vars));
  put("README.md", fill(tpl("README.md"), { ...vars, description }));
  put("CHANGELOG.md", fill(tpl("CHANGELOG.md"), { ...vars, description }));
  put("HOW-IT-FAILS.md", fill(tpl("HOW-IT-FAILS.md"), vars));
  mkdirSync(join(root, "lib"), { recursive: true });
  for (const lib of ["hook-runner.mjs", "live-run.mjs"]) {
    cpSync(join(KIT_ROOT, "lib", lib), join(root, "lib", lib));
    written.push(`lib/${lib}`);
  }
  if (judge) {
    cpSync(join(KIT_ROOT, "lib", "judge.mjs"), join(root, "lib", "judge.mjs"));
    written.push("lib/judge.mjs");
  }
  const hooks = {};
  for (const event of events) {
    const file = `${kebab(event)}.mjs`;
    const spec = EVENTS[event];
    const entry = { hooks: [{ type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${file}"`, timeout: 5 }] };
    if (spec.matcher !== null) entry.matcher = spec.matcher;
    hooks[event] = [entry];
    put(`hooks/${file}`, fill(tpl("hooks/hook.mjs"), { ...vars, event, file, quiet: spec.quiet ? "true" : "false" }), 0o755);
  }
  put("hooks/hooks.json", `${JSON.stringify({ hooks }, null, 2)}\n`);
  put(`skills/${name}/SKILL.md`, fill(tpl("skills/SKILL.md"), { ...vars, description }));
  const manifestEvents = Object.fromEntries(events.map((e) => [e, ["silent"]]));
  put("evals/manifest.json", fill(tpl("evals/manifest.json"), { ...vars, events: JSON.stringify(manifestEvents) }));
  for (const event of events) put(`evals/${kebab(event)}.scenario.json`, fill(tpl("evals/scenario.json"), { ...vars, event, stdin: JSON.stringify(sampleInput(event)) }));
  put("scripts/prune.mjs", fill(tpl("scripts/prune.mjs"), vars), 0o755);
  // The template carries a .template suffix so the kit's own `node --test` does not run it.
  put("test/hook-contract.test.mjs", tpl("test/hook-contract.test.mjs.template"));
  put("test/fixtures/README.md", tpl("test/fixtures/README.md"));
  put("e2e/live-run.sh", fill(tpl("e2e/live-run.sh"), vars), 0o755);
  return { root, written };
}

// Real paths on both sides: node resolves the main module through symlinks (macOS's /var/folders
// tmpdir, a linked checkout); a raw argv compare there is a silent no-op that writes nothing.
const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`new-plugin: ${args.error}\n`);
    process.exit(1);
  }
  try {
    const { root, written } = scaffold(args);
    process.stdout.write(`${root}\n${written.map((w) => `  ${w}`).join("\n")}\nnext: write the rule in hooks/*.mjs, the steps in skills/${args.name}/SKILL.md, the rows in HOW-IT-FAILS.md; run \`node --test\` there; add ${args.name}'s row (name and one sentence, no version) to the root README's plugin table before the first \`ledger gate check\`; add the marketplace entry when it is ready to publish.\n`);
  } catch (err) {
    process.stderr.write(`new-plugin: ${err.message}\n`);
    process.exit(1);
  }
}
