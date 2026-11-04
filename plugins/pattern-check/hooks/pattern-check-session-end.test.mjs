import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle, workingFiles } from "./pattern-check-session-end.mjs";
import { paths, sessionKey, stateDir, writeAtomic } from "../scripts/lib/state.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "pattern-check-session-end.mjs");
const SESSION = "0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-end-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = join(base, "state");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(base, "config"), CLAUDE_PLUGIN_ROOT: dirname(dirname(HOOK)) };
  const sd = stateDir(env, base);
  const payload = (extra = {}) => ({ hook_event_name: "SessionEnd", session_id: SESSION, cwd: repo, reason: "exit", ...extra });
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, HOME: base, ...env }, encoding: "utf8", timeout: 5000 });
  const call = (input) => handle(input, { env, home: base });
  /** All four per-session files, as a session leaves them. */
  const leave = (key = SESSION) => {
    writeAtomic(paths.session(sd, key), JSON.stringify({ files: ["a.ts"], receipt: null }));
    writeAtomic(paths.stop(sd, key), "abc\n");
    writeAtomic(paths.receiptCopy(sd, key), "# receipt\n");
    writeAtomic(paths.current(sd, repo), `${key}\n`);
  };
  return { base, state, repo, env, sd, payload, run, call, leave };
}

test("SessionEnd removes sessions/<key>.json and stop/<key> and keeps the receipt copy and current/<repo>", (t) => {
  const f = fixture(t);
  f.leave();
  assert.equal(f.call(f.payload()), null);
  for (const file of workingFiles(f.sd, SESSION)) assert.equal(existsSync(file), false, file);
  assert.equal(existsSync(paths.receiptCopy(f.sd, SESSION)), true);
  assert.equal(existsSync(paths.current(f.sd, f.repo)), true);
  // Another session's files are not touched.
  f.leave("other-session");
  assert.equal(f.call(f.payload()), null);
  for (const file of workingFiles(f.sd, "other-session")) assert.equal(existsSync(file), true, file);
});

test("rerun-safe: a second SessionEnd for the same session, and one for a session that left nothing, remove nothing and warn nothing", (t) => {
  const f = fixture(t);
  f.leave();
  assert.equal(f.call(f.payload()), null);
  assert.equal(f.call(f.payload()), null);
  assert.equal(f.call(f.payload({ session_id: "never-started" })), null);
  assert.equal(existsSync(join(f.sd, "errors.log")), false);
});

test("a missing session_id degrades to the per-cwd key and removes that key's working files, with the warning", (t) => {
  const f = fixture(t);
  const { key } = sessionKey({ sessionId: undefined, cwd: f.repo });
  f.leave(key);
  const out = f.call(f.payload({ session_id: undefined }));
  assert.match(out.systemMessage, /no usable session_id was available/);
  for (const file of workingFiles(f.sd, key)) assert.equal(existsSync(file), false, file);
});

test("end to end through stdin: exit 0, no stdout, the files are gone", (t) => {
  const f = fixture(t);
  f.leave();
  const r = f.run(f.payload());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  for (const file of workingFiles(f.sd, SESSION)) assert.equal(existsSync(file), false, file);
  assert.equal(existsSync(join(f.sd, "errors.log")), false);
});

test("fail open: a file that cannot be removed leaves the session's end alone, warns once naming the file, and logs to errors.log", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, (t) => {
  const f = fixture(t);
  f.leave();
  const dir = dirname(paths.session(f.sd, SESSION));
  chmodSync(dir, 0o500);
  const r = f.run(f.payload());
  chmodSync(dir, 0o700);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, new RegExp(`^pattern-check: could not remove ${paths.session(f.sd, SESSION).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`));
  assert.equal(out.decision, undefined);
  assert.equal(existsSync(paths.stop(f.sd, SESSION)), false, "the other file still went");
  const log = readFileSync(join(f.sd, "errors.log"), "utf8").trimEnd().split("\n");
  assert.equal(log.length, 1);
  assert.match(log[0], /^\S+Z pattern-check-session-end\.mjs could not remove /);
});

test("process: empty stdin, malformed JSON and a non-object payload exit 0, warn, and log to errors.log", (t) => {
  const f = fixture(t);
  for (const [input, re] of [["", /got empty stdin/], ["{ torn", /got stdin that is not JSON/], ["42", /not a JSON object/]]) {
    const r = f.run(input);
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, re);
    assert.match(out.systemMessage, /the session's working files were left in place$/);
  }
  const log = readFileSync(join(f.sd, "errors.log"), "utf8").trimEnd().split("\n");
  assert.equal(log.length, 3);
  for (const l of log) assert.match(l, /^\S+Z pattern-check-session-end\.mjs the SessionEnd hook got /);
});

test("an unreadable config still removes the files and shows the config fault", (t) => {
  const f = fixture(t);
  f.leave();
  writeFileSync(join(f.repo, ".pattern-check.json"), "{ torn");
  const out = f.call(f.payload());
  assert.match(out.systemMessage, /^pattern-check: /);
  for (const file of workingFiles(f.sd, SESSION)) assert.equal(existsSync(file), false, file);
});
