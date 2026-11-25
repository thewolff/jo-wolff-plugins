// review-helpers.mjs — a git repository in a sandbox, lab stubs, and runners for review, push and
// typed prompts, shared by the 0.4.12 review test files (review-dismiss, review-carry,
// review-waive-lock, review-identity). review.test.mjs keeps its own copies.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandbox, cli, hook, openDb, typed } from "./helpers.mjs";

export const SID = "s-review";

export function git(b, ...args) {
  const r = spawnSync("git", args, { cwd: b.work, encoding: "utf8", env: { ...b.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

export function commit(b, name, text) {
  mkdirSync(dirname(join(b.work, name)), { recursive: true });
  writeFileSync(join(b.work, name), text);
  git(b, "add", name);
  git(b, "commit", "-qm", `add ${name}`);
  return git(b, "rev-parse", "HEAD");
}

/** A repo with a commit on main and one on branch `feat`, the user file's review settings, and a note so the note gate passes. */
export function repo(review = {}, files = { "b.txt": "two\n" }) {
  const b = sandbox();
  git(b, "init", "-q", "-b", "main");
  commit(b, "a.txt", "one\n");
  git(b, "checkout", "-q", "-b", "feat");
  for (const [name, text] of Object.entries(files)) commit(b, name, text);
  b.writeConfig({ review: { mode: "gate", ...review } });
  cli(b, ["note", "pushing the change"], { env: { LEDGER_SESSION_ID: SID } });
  return b;
}

/** An executable stub that prints `reply`, exiting `code`. The reply can be changed between runs with `set`. */
export function stub(b, name, reply, code = 0) {
  const path = join(b.root, `stub-${name}`);
  const set = (text, exit = code) => {
    writeFileSync(path, `#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n${text}\nEOF\nexit ${exit}\n`);
    chmodSync(path, 0o755);
  };
  set(reply);
  return { path, set };
}

export const review = (b, args = [], env = {}) => cli(b, ["review", ...args], { env: { LEDGER_SESSION_ID: SID, ...env } });
export const push = (b, command = "git push origin feat", env = {}) =>
  hook(b, "pre-tool-use", { session_id: SID, cwd: b.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, { env });
export const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? "allow";
export const denyText = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? "";
export { typed };

/** Every cc_reviews row, oldest first by id, with its items parsed. */
export function reviewRows(b) {
  const db = openDb(b);
  try {
    return db
      .prepare("SELECT * FROM cc_reviews ORDER BY id")
      .all()
      .map((r) => ({ ...r, items: r.findings_json ? JSON.parse(r.findings_json) : [] }));
  } finally {
    db.close();
  }
}

/** Every cc_dismissals row, oldest first. */
export function dismissals(b) {
  const db = openDb(b);
  try {
    return db.prepare("SELECT * FROM cc_dismissals ORDER BY at, id").all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

/** The open item ids of the latest row of `lab`. */
export function openIds(b, lab = "codex") {
  const row = reviewRows(b).filter((r) => r.lab === lab).at(-1);
  return (row?.items ?? []).filter((i) => !i.resolved).map((i) => i.id);
}
