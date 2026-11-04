// common.mjs — what every review adapter shares: the prompt, the binary lookup, a child-process
// runner with a hard timeout, and the reply parser.
//
// Adapter shape (lib/review/<lab>.mjs):
//   export const lab = "<lab>";  export const defaultBin = "<binary>";
//   export async function run({ diff, cwd, timeoutMs, env, config }) → { verdict: "pass"|"findings", findings, model }
// and throws on any failure (missing binary, non-zero exit, timeout, empty reply); the caller
// records a thrown error as an `unavailable` row.

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const PROMPT = [
  "You are reviewing a code change. The unified diff follows.",
  "Review it for bugs, security problems and broken contracts (APIs, schemas, callers the diff does not update).",
  "Do not run tools or change files; read the diff only.",
  "Reply with the findings as a numbered markdown list, one finding per item with the file and line, most serious first.",
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

/** The reply as a verdict: the single word PASS → pass; any other non-empty text → findings. */
export function parseReply(text) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("empty reply");
  if (/^\**\s*pass\s*\**\.?$/i.test(t)) return { verdict: "pass", findings: null };
  return { verdict: "findings", findings: t };
}

/** How many findings a findings text holds: its numbered items, at least 1. */
export function countFindings(text) {
  const n = String(text ?? "").split("\n").filter((l) => /^\s*\d+[.)]\s/.test(l)).length;
  return Math.max(1, n);
}
