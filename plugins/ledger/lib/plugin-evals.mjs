// plugin-evals.mjs — what the gate's `evals` and `retention` rows read from a plugin tree: its
// hook registrations, `evals/manifest.json`, `evals/*.scenario.json`, the `state` field of
// `.claude-plugin/plugin.json`, and the source sites that write outside a worktree. Pure: no
// process is spawned and nothing is written. The scenario rules here are the same ones
// plugin-kit's lib/live-run.mjs (the runner) applies; the two are kept in step by
// test/plugin-gate.test.mjs, which runs both over the same fixtures.
//
// How it fails: a manifest or scenario that does not parse is reported as a problem naming the
// file, never thrown; a plugin.json that does not parse makes `readState` return an error string
// the retention row prints.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const OUTCOMES = Object.freeze(["deny", "allow", "ask", "systemMessage", "silent"]);
const SCENARIO_SUFFIX = ".scenario.json";

/** The events hooks/hooks.json registers, in order; [] without the file or when it does not parse. */
export function registeredEvents(pluginDir) {
  const path = join(pluginDir, "hooks", "hooks.json");
  if (!existsSync(path)) return [];
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return Object.keys(json.hooks ?? {});
  } catch {
    return [];
  }
}

/** evals/manifest.json → { manifest, path, error? }; manifest null when absent or broken. */
export function loadManifest(pluginDir) {
  const path = join(pluginDir, "evals", "manifest.json");
  if (!existsSync(path)) return { manifest: null, path };
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { manifest: null, path, error: "evals/manifest.json is not an object" };
    if (manifest.events !== undefined && (typeof manifest.events !== "object" || Array.isArray(manifest.events))) return { manifest: null, path, error: "evals/manifest.json: events must be an object of event → outcomes" };
    if (manifest.unusedPayload !== undefined && !Array.isArray(manifest.unusedPayload)) return { manifest: null, path, error: "evals/manifest.json: unusedPayload must be an array of events" };
    return { manifest, path };
  } catch (err) {
    return { manifest: null, path, error: `evals/manifest.json does not parse (${err.message})` };
  }
}

/**
 * Every evals/<name>.scenario.json, parsed and shape-checked against the manifest and the
 * registered events: `{ scenarios, errors }`. A scenario with a problem keeps `error`.
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
    if (s.stub === true) problems.push('is an unfilled stub (remove "stub": true once its stdin and expect are real)');
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
 * The manifest's coverage of the registered events: every event declared with outcomes, every
 * declared event × outcome proved by one scenario that is not a stub. The problems, in order.
 */
export function coverageProblems({ manifest, scenarios, events }) {
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

// ---- retention -------------------------------------------------------------------------------

/** Placeholder roots a declared path or an observed write may start with, each as a `~`-rooted form. */
const ROOTS = Object.freeze({ "$HOME": "~", "$XDG_STATE_HOME": "~/.local/state", "$XDG_DATA_HOME": "~/.local/share", "$XDG_CONFIG_HOME": "~/.config", "$XDG_CACHE_HOME": "~/.cache" });

/** A declared or observed path in one canonical form: `~/…`, `$TMPDIR/…`, `<worktree>/…`, or itself. */
export function canonicalPath(p) {
  let s = String(p).trim().replace(/\/+$/, "");
  s = s.replace(/^\$\{([A-Z_]+)\}/, "$$$1");
  for (const [root, tilde] of Object.entries(ROOTS)) {
    if (s === root) return tilde;
    if (s.startsWith(`${root}/`)) return `${tilde}${s.slice(root.length)}`;
  }
  return s;
}

/** True when `write` (canonical) sits under `declared` (canonical, `*` matches one segment). */
export function underDeclared(write, declared) {
  const w = canonicalPath(write).split("/");
  const d = canonicalPath(declared).split("/");
  if (d.length > w.length) return false;
  return d.every((seg, i) => seg === "*" || seg === w[i] || (seg.includes("*") && new RegExp(`^${seg.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(w[i])));
}

/**
 * The `state` field of .claude-plugin/plugin.json: `{ state, declared, problems }` where `state`
 * is the raw array (undefined when the field is absent), `declared` the well-formed entries
 * (`{ path, retentionDays, prune, kind }`; `kind` is "dir" unless the entry says "file"),
 * `problems` what is wrong with the rest. A plugin.json that does not parse → `error`.
 */
export function readState(pluginDir) {
  const path = join(pluginDir, ".claude-plugin", "plugin.json");
  if (!existsSync(path)) return { state: undefined, declared: [], problems: [] };
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { state: undefined, declared: [], problems: [], error: `.claude-plugin/plugin.json does not parse (${err.message})` };
  }
  const state = json.state;
  if (state === undefined) return { state, declared: [], problems: [] };
  if (!Array.isArray(state)) return { state, declared: [], problems: [".claude-plugin/plugin.json: state must be an array of { path, retentionDays, prune }"] };
  const declared = [];
  const problems = [];
  state.forEach((e, i) => {
    const at = `.claude-plugin/plugin.json state[${i}]`;
    if (!e || typeof e !== "object") return problems.push(`${at} is not an object`);
    if (typeof e.path !== "string" || !e.path.trim()) return problems.push(`${at} has no path`);
    if (!(e.retentionDays === null || (Number.isInteger(e.retentionDays) && e.retentionDays >= 0))) return problems.push(`${at} (${e.path}): retentionDays must be a whole number of days or null (kept by design)`);
    if (e.retentionDays !== null && e.retentionDays > 0 && (typeof e.prune !== "string" || !e.prune.trim())) return problems.push(`${at} (${e.path}): retentionDays ${e.retentionDays} with no prune command`);
    if (e.prune !== undefined && e.prune !== null && typeof e.prune !== "string") return problems.push(`${at} (${e.path}): prune must be a command string or null`);
    if (e.kind !== undefined && e.kind !== "dir" && e.kind !== "file") return problems.push(`${at} (${e.path}): kind must be "dir" (the default) or "file"`);
    declared.push({ path: e.path, retentionDays: e.retentionDays, prune: typeof e.prune === "string" && e.prune.trim() ? e.prune : null, kind: e.kind === "file" ? "file" : "dir" });
  });
  return { state, declared, problems };
}

export const WRITE_SITE = /XDG_STATE_HOME|XDG_DATA_HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME|homedir\(|\.local\/|mkdtemp|writeFileSync|appendFileSync|createWriteStream/;
const SOURCE_EXT = /\.(mjs|cjs|js|ts|tsx|sh|py|rb)$/;
const SKIP_DIRS = new Set(["node_modules", "test", "tests", "fixtures", "evals", "e2e", "landlock", ".git", "licenses"]);
const SKIP_FILES = /(\.test\.(mjs|cjs|js|ts|tsx)$)|(^live-run\.mjs$)|(^hook-runner\.mjs$)/;

/**
 * Every source line (not tests, fixtures, evals or e2e) that writes or resolves a path outside a
 * worktree: `[{ file, line, text }]`, relative to the plugin, sorted. `lib/live-run.mjs` and
 * `lib/hook-runner.mjs` are the kit's copies and are skipped: their sandboxes are their own.
 */
export function writeSites(pluginDir) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith(".")) continue;
        walk(p);
        continue;
      }
      if (!SOURCE_EXT.test(d.name) || SKIP_FILES.test(d.name)) continue;
      const rel = relative(pluginDir, p);
      if (rel.startsWith("templates/")) continue;
      let text;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        const t = line.trim();
        if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("#") || t.startsWith("import ")) return;
        if (WRITE_SITE.test(line)) out.push({ file: rel, line: i + 1, text: t.slice(0, 120) });
      });
    }
  };
  walk(pluginDir);
  return out;
}

/**
 * The retention row's problems for a plugin: `state` malformed; write sites with no `state`
 * field; observed writes (placeholder paths, from the canary) under no declared path.
 */
export function retentionProblems(pluginDir, { observedWrites = [] } = {}) {
  const st = readState(pluginDir);
  if (st.error) return { problems: [st.error], sites: [], declared: [], state: undefined };
  const problems = [...st.problems];
  const sites = writeSites(pluginDir);
  if (st.state === undefined && sites.length) {
    const named = sites.slice(0, 5).map((s) => `${s.file}:${s.line}`).join(", ");
    problems.push(`no \`state\` field in .claude-plugin/plugin.json, yet ${sites.length} source site(s) write or resolve paths outside the worktree: ${named}${sites.length > 5 ? `, +${sites.length - 5} more` : ""}`);
  } else if (Array.isArray(st.state) && !st.state.length && sites.length) {
    const named = sites.slice(0, 5).map((s) => `${s.file}:${s.line}`).join(", ");
    problems.push(`\`state\` is empty, yet ${sites.length} source site(s) write or resolve paths outside the worktree: ${named}${sites.length > 5 ? `, +${sites.length - 5} more` : ""}`);
  }
  for (const w of observedWrites) {
    if (!st.declared.some((d) => underDeclared(w, d.path))) problems.push(`the canary saw a write at ${w} under no declared state path${st.declared.length ? ` (declared: ${st.declared.map((d) => d.path).join(", ")})` : ""}`);
  }
  return { problems, sites, declared: st.declared, state: st.state };
}
