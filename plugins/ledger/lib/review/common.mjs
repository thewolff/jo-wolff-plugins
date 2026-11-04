// common.mjs — what every review adapter shares: the prompt, the binary lookup, the reviewer's
// environment and scratch folder, a child-process runner with a hard timeout, and the reply parser.
//
// Adapter shape (lib/review/<lab>.mjs):
//   export const lab = "<lab>";  export const defaultBin = "<binary>";
//   export const envKeys = [ … ];  (names or `PREFIX_*` patterns the lab's CLI needs, on top of BASE_ENV_KEYS)
//   export async function run({ diff, timeoutMs, env, config }) → { verdict, findings, items, model }
//   (verdict, findings and items as parseReply returns them)
// and throws on any failure (missing binary, non-zero exit, timeout, empty reply); the caller
// records a thrown error as an `unavailable` row.
//
// Containment: a reviewer reads the diff it is handed and nothing else. Every adapter runs its CLI
// with the lab's own tool-free switch (see each adapter), in a fresh empty scratch folder (so no
// repository-scoped agent, settings, hooks or instructions are discovered), with an environment
// built from an allowlist (reviewerEnv) instead of the caller's, and LEDGER_ENABLED=0 so the
// ledger's own hooks stay out of a nested session. The prompt's "do not run tools" line is not
// relied on.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const SEVERITIES = Object.freeze(["blocking", "should", "nit"]);

export const PROMPT = [
  "You are reviewing a code change. The unified diff follows.",
  "Review it for bugs, security problems and broken contracts (APIs, schemas, callers the diff does not update).",
  "Do not run tools or change files; read the diff only.",
  "Reply with the findings as a numbered markdown list, one finding per item with the file and line, most serious first.",
  "Start every finding with its severity in square brackets: [blocking] must be fixed before merging, [should] ought to be fixed, [nit] optional polish.",
  "If you find nothing worth fixing, reply with the single word PASS and nothing else.",
].join("\n");

/** The binary for `lab`: env LEDGER_REVIEW_BIN_<LAB> when set, else `fallback`. */
export function binFor(lab, fallback, env = process.env) {
  return env[`LEDGER_REVIEW_BIN_${lab.toUpperCase()}`] || fallback;
}

/** Variables every reviewer keeps: process basics, locale, XDG folders, proxies and CA bundles. */
export const BASE_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "TZ", "LANG", "LC_*",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);

/**
 * The reviewer's environment: only the variables in BASE_ENV_KEYS and `keys` (exact names, or
 * `PREFIX_*` for every name starting with PREFIX_), plus LEDGER_ENABLED=0.
 */
export function reviewerEnv(env, keys = []) {
  const patterns = [...BASE_ENV_KEYS, ...keys];
  const exact = new Set(patterns.filter((k) => !k.endsWith("*")));
  const prefixes = patterns.filter((k) => k.endsWith("*")).map((k) => k.slice(0, -1));
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v !== undefined && (exact.has(k) || prefixes.some((p) => k.startsWith(p)))) out[k] = v;
  }
  out.LEDGER_ENABLED = "0";
  return out;
}

/** Run `fn(dir)` with a fresh empty folder, removed afterwards. */
export async function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-review-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The absolute path `bin` resolves to on env.PATH (or itself when absolute and executable); null when absent. */
export function which(bin, env = process.env) {
  const ok = (p) => {
    try {
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(bin) || bin.includes("/")) return ok(bin) ? bin : null;
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (dir && ok(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

/**
 * Run `bin args` in `cwd`, writing `input` to stdin; resolve { stdout, stderr } on exit 0, reject
 * on a spawn error, a non-zero exit (with the stderr tail) or `timeoutMs`. The child leads its own
 * process group, and a timeout kills the whole group, so a CLI's own children do not outlive it.
 */
export function runProcess(bin, args, { input = "", cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const killGroup = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish(() => reject(err.code === "ENOENT" ? new Error(`${bin} not found`) : err)));
    child.on("close", (code, signal) =>
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${bin} exited ${code ?? signal}: ${tail(stderr || stdout)}`));
      }),
    );
    child.stdin.on("error", () => {
      /* the child closed stdin early; its exit code tells the story */
    });
    child.stdin.end(input);
  });
}

function tail(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 300 ? `…${t.slice(-300)}` : t || "(no output)";
}

/**
 * The reply as a verdict. The single word PASS → pass, no items. Otherwise each numbered list
 * item is one finding, its severity from a leading `[blocking]`, `[should]` or `[nit]` (any case,
 * optionally bold), untagged → should; a reply with no numbered item is one untagged finding.
 * Only nits → `pass-with-nits`; any blocking or should → `findings`.
 * @returns {{ verdict: "pass"|"pass-with-nits"|"findings", findings: string|null, items: Array<{severity, text}> }}
 */
export function parseReply(text) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("empty reply");
  if (/^\**\s*pass\s*\**\.?$/i.test(t)) return { verdict: "pass", findings: null, items: [] };
  const items = parseItems(t);
  const verdict = items.every((i) => i.severity === "nit") ? "pass-with-nits" : "findings";
  return { verdict, findings: t, items };
}

/** The numbered items of `text` with their severity (see parseReply); continuation lines join their item. */
export function parseItems(text) {
  const items = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (m) items.push(m[1]);
    else if (items.length && line.trim()) items[items.length - 1] += `\n${line.trim()}`;
  }
  if (!items.length) items.push(String(text).trim());
  return items.map((raw) => {
    const tag = /^\s*\**\s*\[(blocking|should|nit)\]\s*\**\s*/i.exec(raw);
    return tag ? { severity: tag[1].toLowerCase(), text: raw.slice(tag[0].length).trim() } : { severity: "should", text: raw.trim() };
  });
}

/** { blocking, should, nit } counts for a list of items, leaving out items marked `resolved`. */
export function severityCounts(items) {
  const c = { blocking: 0, should: 0, nit: 0 };
  for (const i of items ?? []) if (!i.resolved) c[i.severity] = (c[i.severity] ?? 0) + 1;
  return c;
}
