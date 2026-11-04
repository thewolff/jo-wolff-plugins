#!/usr/bin/env node
// scripts/new-plugin.mjs — scaffold a plugin that meets the repository test bar on day one.
//
//   node scripts/new-plugin.mjs <name> --events PreToolUse,Stop[,…] [--description "…"] [--dest <plugins dir>]
//   (run it from inside the repository the plugin is for)
//
// Writes <dest>/<name>/ from templates/ (default dest: the `plugins/` of the git repository the
// cwd is in, found with `git rev-parse --show-toplevel`; a cwd in no repository is refused
// naming --dest: the kit's own checkout, or the marketplace cache it is installed from, is
// never the destination), with
// {{name}}, {{title}}, {{description}}, and per hook {{event}}, {{file}}, {{quiet}} filled in:
//
//   .claude-plugin/plugin.json, package.json, README.md, HOW-IT-FAILS.md
//   lib/hook-runner.mjs            a COPY of plugin-kit/lib/hook-runner.mjs (the plugin owns it)
//   hooks/hooks.json               one entry per event, `node "${CLAUDE_PLUGIN_ROOT}/hooks/<event>.mjs"`, timeout 5
//   hooks/<event>.mjs              one handler per event, returning null (allow) until a rule is written
//   skills/<name>/SKILL.md         with the "When this can't run" section
//   test/hook-contract.test.mjs    the five fault inputs, per hook
//   test/fixtures/README.md        the <x>.txt / <x>.unavailable.txt sibling rule
//   e2e/live-run.sh                the canary contract (exit 0 pass, 75 unavailable, stdout kept)
//
// Refuses: a name that is not lowercase kebab, an event not in the host's list, an existing
// destination (nothing is overwritten; delete it yourself first), no events. Exit 1 with the
// reason on stderr; exit 0 with the written paths on stdout. The marketplace entry
// (.claude-plugin/marketplace.json at the repository root) is not written: add it by hand, with
// the one-sentence description, when the plugin is ready to publish.

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const [name, ...rest] = argv;
  const out = { name, events: [], description: "", dest: null };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--events" && rest[i + 1]) out.events = rest[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (t === "--description" && rest[i + 1]) out.description = rest[++i];
    else if (t === "--dest" && rest[i + 1]) out.dest = rest[++i];
    else return { error: `unknown argument ${t}` };
  }
  if (!name || name.startsWith("--")) return { error: "usage: new-plugin.mjs <name> --events A,B [--description …] [--dest <plugins dir>]" };
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
export function scaffold({ name, events, description, dest }) {
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
  put(".claude-plugin/plugin.json", fill(tpl(".claude-plugin/plugin.json"), vars));
  put("package.json", fill(tpl("package.json"), vars));
  put("README.md", fill(tpl("README.md"), { ...vars, description }));
  put("HOW-IT-FAILS.md", fill(tpl("HOW-IT-FAILS.md"), vars));
  mkdirSync(join(root, "lib"), { recursive: true });
  cpSync(join(KIT_ROOT, "lib", "hook-runner.mjs"), join(root, "lib", "hook-runner.mjs"));
  written.push("lib/hook-runner.mjs");
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
  // The template carries a .template suffix so the kit's own `node --test` does not run it.
  put("test/hook-contract.test.mjs", tpl("test/hook-contract.test.mjs.template"));
  put("test/fixtures/README.md", tpl("test/fixtures/README.md"));
  put("e2e/live-run.sh", fill(tpl("e2e/live-run.sh"), vars), 0o755);
  return { root, written };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`new-plugin: ${args.error}\n`);
    process.exit(1);
  }
  try {
    const { root, written } = scaffold(args);
    process.stdout.write(`${root}\n${written.map((w) => `  ${w}`).join("\n")}\nnext: write the rule in hooks/*.mjs, the steps in skills/${args.name}/SKILL.md, the rows in HOW-IT-FAILS.md; run \`node --test\` there; add the marketplace entry when it is ready to publish.\n`);
  } catch (err) {
    process.stderr.write(`new-plugin: ${err.message}\n`);
    process.exit(1);
  }
}
