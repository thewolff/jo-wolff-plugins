// common.mjs — what every review adapter shares: the prompt, the binary lookup, a child-process
// runner with a hard timeout, and the reply parser.
//
// Adapter shape (lib/review/<lab>.mjs):
//   export const lab = "<lab>";  export const defaultBin = "<binary>";
//   export async function run({ diff, cwd, timeoutMs, env, config }) → { verdict, findings, items, model }
//   (verdict, findings and items as parseReply returns them)
// and throws on any failure (missing binary, non-zero exit, timeout, empty reply); the caller
// records a thrown error as an `unavailable` row.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
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
 * on a spawn error, a non-zero exit (with the stderr tail) or `timeoutMs` (the child is killed).
 */
export function runProcess(bin, args, { input = "", cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
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
