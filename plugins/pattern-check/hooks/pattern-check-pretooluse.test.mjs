import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { filePathsOf, handle } from "./pattern-check-pretooluse.mjs";
import { REAL_ABSENT, REAL_PIN } from "../test-fixtures/real-commands.mjs";
import { paths, stateDir } from "../scripts/lib/state.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "pattern-check-pretooluse.mjs");
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "pattern-check.mjs");
const SESSION = "0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10";

// A temp HOME with its own XDG state and config, a git-looking repo, and a payload builder.
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-pre-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = join(base, "state");
  const config = join(base, "config");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: config, CLAUDE_PLUGIN_ROOT: dirname(dirname(HOOK)) };
  const sd = stateDir(env, base);
  const file = (name) => join(repo, "src", name);
  const edit = (name, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: repo, tool_name: "Edit", tool_input: { file_path: file(name), old_string: "a", new_string: "b" }, ...extra });
  const write = (name, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: repo, tool_name: "Write", tool_input: { file_path: file(name), content: "x" }, ...extra });
  const bash = (command, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: repo, tool_name: "Bash", tool_input: { command }, ...extra });
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, HOME: base, ...env }, encoding: "utf8", timeout: 5000 });
  const call = (input) => handle(input, { env, home: base });
  const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? null;
  const setUser = (text) => { mkdirSync(join(config, "pattern-check"), { recursive: true }); writeFileSync(join(config, "pattern-check", "config.json"), text); };
  const setRepo = (text) => writeFileSync(join(repo, ".pattern-check.json"), text);
  const record = (args = ["--no-new-pieces", "test"]) => spawnSync(process.execPath, [CLI, "record", "--session", SESSION, "--cwd", repo, ...args], { env: { ...process.env, HOME: base, ...env }, encoding: "utf8" });
  return { base, state, repo, env, sd, file, edit, write, bash, run, call, decision, setUser, setRepo, record };
}

test("under the threshold it never fires: files 1 and 2 are allowed and counted; the 3rd distinct file is denied and not counted", (t) => {
  const f = fixture(t);
  assert.equal(f.call(f.edit("a.ts")), null);
  assert.equal(f.call(f.write("b.ts")), null);
  const third = f.call(f.edit("c.ts"));
  assert.equal(f.decision(third), "deny");
  const session = JSON.parse(readFileSync(paths.session(f.sd, SESSION), "utf8"));
  assert.deepEqual(session.files, [f.file("a.ts"), f.file("b.ts")]);
  // Every later new file is denied too; the already-counted files are still editable.
  assert.equal(f.decision(f.call(f.edit("d.ts"))), "deny");
  assert.equal(f.call(f.edit("a.ts")), null);
});

test("the same file counts once however it is spelled: N-1 edits of one file never fire", (t) => {
  const f = fixture(t);
  assert.equal(f.call(f.edit("a.ts")), null);
  assert.equal(f.call(f.edit("a.ts")), null);
  assert.equal(f.call(f.write("a.ts")), null);
  assert.equal(f.call({ ...f.edit("a.ts"), tool_input: { file_path: join(f.repo, "src", "..", "src", "a.ts") } }), null);
  assert.equal(f.call({ ...f.edit("a.ts"), tool_input: { file_path: `${f.repo}\\src\\a.ts` } }), null);
  assert.equal(f.call(f.edit("b.ts")), null);
  assert.deepEqual(JSON.parse(readFileSync(paths.session(f.sd, SESSION), "utf8")).files, [f.file("a.ts"), f.file("b.ts")]);
  assert.equal(f.decision(f.call(f.edit("c.ts"))), "deny");
});

test("the deny text names the exact record command with --session, the count, and the blocked call", (t) => {
  const f = fixture(t);
  f.call(f.edit("a.ts"));
  f.call(f.edit("b.ts"));
  const out = f.call(f.edit("c.ts"));
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(reason, /touched 2 distinct files and the threshold is 3/);
  assert.ok(reason.includes(`node "${CLI}" record --session ${SESSION} < table.md`), reason);
  assert.ok(reason.includes(`record --session ${SESSION} --no-new-pieces "<reason>"`), reason);
  assert.ok(reason.includes(`Blocked call: Edit ${f.file("c.ts")}.`), reason);
});

test("end to end through stdin: exit 0 and the deny JSON on the Nth file; nothing on stdout before", (t) => {
  const f = fixture(t);
  assert.deepEqual([f.run(f.edit("a.ts")).stdout, f.run(f.edit("b.ts")).stdout], ["", ""]);
  const r = f.run(f.edit("c.ts"));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("the threshold is configurable: threshold 2 fires on the 2nd file, threshold 5 not before the 5th", (t) => {
  const f = fixture(t);
  f.setRepo(JSON.stringify({ threshold: 2 }));
  assert.equal(f.call(f.edit("a.ts")), null);
  assert.equal(f.decision(f.call(f.edit("b.ts"))), "deny");
  f.setRepo(JSON.stringify({ threshold: 5 }));
  for (const n of ["b", "c", "d"]) assert.equal(f.call(f.edit(`${n}.ts`)), null);
  assert.equal(f.decision(f.call(f.edit("e.ts"))), "deny");
});

test("a receipt lifts the deny: record via the CLI, then the next edit, commit and PR are allowed", (t) => {
  const f = fixture(t);
  f.call(f.edit("a.ts"));
  f.call(f.edit("b.ts"));
  assert.equal(f.decision(f.call(f.edit("c.ts"))), "deny");
  const rec = f.record();
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(existsSync(join(f.repo, ".pattern-check", `${SESSION}.md`)), true);
  assert.equal(f.call(f.edit("c.ts")), null);
  assert.equal(f.call(f.bash("git commit -m x")), null);
  assert.equal(f.call(f.bash("gh pr create --fill")), null);
  // The state copy alone also lifts it.
  rmSync(join(f.repo, ".pattern-check"), { recursive: true });
  assert.equal(f.call(f.edit("d.ts")), null);
});

test("Bash: git commit, gh pr create, in-repo redirects, sed -i and tee are denied at the threshold, allowed below it", (t) => {
  const f = fixture(t);
  assert.equal(f.call(f.bash("git commit -m early")), null);
  f.call(f.edit("a.ts"));
  f.call(f.edit("b.ts"));
  assert.equal(f.call(f.bash("git commit -m still-under")), null);
  // The counter reaches 3 through a shell write target inside the repo.
  assert.equal(f.decision(f.call(f.bash("echo x > src/c.ts"))), "deny");
  f.setRepo(JSON.stringify({ threshold: 2 }));
  for (const [cmd, matched] of [
    ["git commit -m x", "git commit"],
    ["gh pr create --fill", "gh pr create"],
    ["echo x > src/new.ts", "redirect"],
    ["sed -i 's/a/b/' src/a.ts", "sed -i"],
    ["make | tee build.log", "tee"],
  ]) {
    const out = f.call(f.bash(cmd));
    assert.equal(f.decision(out), "deny", cmd);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(`matched: ${matched.replace(/[-]/g, "\\-")}`));
  }
  // Writes outside the repository and reads are not denied.
  assert.equal(f.call(f.bash("echo x > /tmp/scratch.txt")), null);
  assert.equal(f.call(f.bash("git status")), null);
  assert.equal(f.call(f.bash("npm test 2>&1 | tail -5")), null);
});

test("configured denyCommands are denied once the session is held, with the matcher named; Bash alone never holds a fresh session", (t) => {
  const f = fixture(t);
  f.setUser(JSON.stringify({ threshold: 1, denyCommands: ["^terraform apply"] }));
  assert.equal(f.call(f.bash("terraform apply")), null); // no file named yet: under N
  assert.equal(f.decision(f.call(f.edit("a.ts"))), "deny"); // the 1st file is the Nth: held from here
  const out = f.call(f.bash("terraform apply"));
  assert.equal(f.decision(out), "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /matched: configured: \^terraform apply/);
  assert.equal(f.call(f.bash("terraform plan")), null);
});

test("the held flag: once the Nth file was denied, commit and PR are denied even though the count stays at N-1", (t) => {
  const f = fixture(t);
  f.call(f.edit("a.ts"));
  f.call(f.edit("b.ts"));
  assert.equal(f.call(f.bash("git commit -m under")), null);
  assert.equal(f.decision(f.call(f.edit("c.ts"))), "deny");
  assert.equal(JSON.parse(readFileSync(paths.session(f.sd, SESSION), "utf8")).held, true);
  assert.equal(f.decision(f.call(f.bash("git commit -m held"))), "deny");
  assert.equal(f.decision(f.call(f.bash("gh pr create --fill"))), "deny");
  assert.equal(f.call(f.bash("git status")), null);
});

test("fail open on a corrupt state file: the call is allowed, a systemMessage warns, and the counter restarts", (t) => {
  const f = fixture(t);
  f.call(f.edit("a.ts"));
  f.call(f.edit("b.ts"));
  writeFileSync(paths.session(f.sd, SESSION), "{ torn");
  const r = f.run(f.edit("c.ts"));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.match(out.systemMessage, /^pattern-check: state file .* is not valid JSON/);
  assert.match(out.systemMessage, /this call was allowed/);
  // The hook rewrote a fresh record with the one file it just saw.
  assert.deepEqual(JSON.parse(readFileSync(paths.session(f.sd, SESSION), "utf8")).files, [f.file("c.ts")]);
});

test("fail open on a corrupt config: the call is allowed under the default threshold, with a warning", (t) => {
  const f = fixture(t);
  f.setRepo("{ not json");
  assert.match(f.call(f.edit("a.ts")).systemMessage, /not valid JSON/);
  assert.match(f.call(f.edit("b.ts")).systemMessage, /not valid JSON/);
  const out = f.call(f.edit("c.ts"));
  assert.equal(f.decision(out), "deny"); // the defaults still apply once the config is set aside
  assert.match(out.systemMessage, /not valid JSON/);
});

// Every spawned hook below runs under spawnSync's 5 s timeout: a hang is r.error (ETIMEDOUT), a
// failure, never a skip.
const exitedClean = (r) => { assert.equal(r.error, undefined, String(r.error)); assert.equal(r.status, 0, r.stderr); };
const errorsLog = (f) => readFileSync(join(f.sd, "errors.log"), "utf8");

test("process: empty stdin, malformed JSON and a non-object payload exit 0, allow, warn in one line, and log to errors.log", (t) => {
  const f = fixture(t);
  for (const [input, re] of [["", /got empty stdin/], ["not json", /got stdin that is not JSON/], ["[]", /not a JSON object/]]) {
    const r = f.run(input);
    exitedClean(r);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, re);
    assert.match(out.systemMessage, /this call was allowed$/);
  }
  const lines = errorsLog(f).trimEnd().split("\n");
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, /^\d{4}-\d\d-\d\dT\S+Z pattern-check-pretooluse\.mjs the PreToolUse hook got /);
});

test("process: an unwritable state directory allows every call, warns, and says errors.log could not be written", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.base, "state-file"), "");
  const env = { ...process.env, HOME: f.base, ...f.env, XDG_STATE_HOME: join(f.base, "state-file") };
  for (const n of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(f.edit(n)), env, encoding: "utf8", timeout: 5000 });
    exitedClean(r);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput, undefined, n); // never denies: nothing could be counted
    assert.match(out.systemMessage, /could not write the state file .*this call was allowed and not counted/);
    assert.match(out.systemMessage, /\(and errors\.log could not be written: /);
  }
});

test("process: a missing config is the zero-config default, with no warning; an unparsable one warns and is logged", (t) => {
  const f = fixture(t);
  exitedClean(f.run(f.edit("a.ts")));
  assert.equal(f.run(f.edit("a.ts")).stdout, "");
  assert.equal(existsSync(join(f.sd, "errors.log")), false);
  f.setUser("{ torn");
  const r = f.run(f.edit("a.ts"));
  exitedClean(r);
  assert.match(JSON.parse(r.stdout).systemMessage, /user config .* is not valid JSON/);
  assert.match(errorsLog(f), /pattern-check-pretooluse\.mjs user config .*config\.json is not valid JSON/);
});

test("process: a corrupt state file allows, warns, and is logged naming the file", (t) => {
  const f = fixture(t);
  f.run(f.edit("a.ts"));
  writeFileSync(paths.session(f.sd, SESSION), "{ torn");
  const r = f.run(f.edit("b.ts"));
  exitedClean(r);
  assert.match(JSON.parse(r.stdout).systemMessage, /state file .*\.json is not valid JSON/);
  assert.match(errorsLog(f), new RegExp(`pattern-check-pretooluse\\.mjs state file .*${SESSION}\\.json is not valid JSON`));
});

test("process: stdin held open is abandoned at the deadline, inside the 5 s budget, and the call allowed", async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: f.base, ...f.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stdin.write('{"tool_name":');
  const started = Date.now();
  const code = await new Promise((resolve, reject) => {
    const killer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("hook hung past 5 s")); }, 5000);
    child.on("exit", (c) => { clearTimeout(killer); resolve(c); });
  });
  child.stdin.destroy();
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 5000);
  assert.match(JSON.parse(stdout).systemMessage, /did not get a closed stdin within 2 s; this call was allowed/);
});

test("process: a well-formed payload under the threshold prints nothing and logs nothing", (t) => {
  const f = fixture(t);
  const r = f.run(f.edit("a.ts"));
  exitedClean(r);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(join(f.sd, "errors.log")), false);
});

test("hooks.preToolUse false switches the hook off", (t) => {
  const f = fixture(t);
  f.setUser(JSON.stringify({ hooks: { preToolUse: false } }));
  for (const n of ["a", "b", "c", "d"]) assert.equal(f.call(f.edit(`${n}.ts`)), null);
});

test("a missing session_id degrades to a per-cwd key with a warning, and still counts", (t) => {
  const f = fixture(t);
  const noId = (n) => { const p = f.edit(n); delete p.session_id; return p; };
  const first = f.call(noId("a.ts"));
  assert.match(first.systemMessage, /no usable session_id .* keyed by its working directory \(cwd-[0-9a-f]{16}\)/);
  assert.equal(first.hookSpecificOutput, undefined);
  f.call(noId("b.ts"));
  const out = f.call(noId("c.ts"));
  assert.equal(f.decision(out), "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /--session cwd-[0-9a-f]{16}/);
});

test("the current-session pointer is written on every call so the CLI can find the session", (t) => {
  const f = fixture(t);
  f.call(f.bash("ls"));
  assert.equal(readFileSync(paths.current(f.sd, f.repo), "utf8").trim(), SESSION);
});

test("other tools pass through untouched", (t) => {
  const f = fixture(t);
  f.setRepo(JSON.stringify({ threshold: 1 }));
  assert.equal(f.call({ ...f.edit("a.ts"), tool_name: "Read" }), null);
  assert.equal(f.call({ ...f.edit("a.ts"), tool_name: "Grep" }), null);
});

test("filePathsOf reads file_path, notebook_path and MultiEdit's edits[]", () => {
  assert.deepEqual(filePathsOf({ file_path: "/a" }), ["/a"]);
  assert.deepEqual(filePathsOf({ notebook_path: "/n.ipynb", new_source: "x" }), ["/n.ipynb"]);
  assert.deepEqual(filePathsOf({ edits: [{ file_path: "/a" }, { file_path: "/b" }, { nope: 1 }] }), ["/a", "/b"]);
  assert.deepEqual(filePathsOf({}), []);
  assert.deepEqual(filePathsOf(undefined), []);
});

test("the field names Claude Code sends: Write and Edit file_path, MultiEdit file_path with edits[] of strings, NotebookEdit notebook_path all count", (t) => {
  const f = fixture(t);
  f.setRepo(JSON.stringify({ threshold: 5 }));
  assert.equal(f.call(f.write("w.ts")), null);
  assert.equal(f.call(f.edit("e.ts")), null);
  assert.equal(f.call({ ...f.edit("m.ts"), tool_name: "MultiEdit", tool_input: { file_path: f.file("m.ts"), edits: [{ old_string: "a", new_string: "b" }] } }), null);
  assert.equal(f.call({ ...f.edit("n.ipynb"), tool_name: "NotebookEdit", tool_input: { notebook_path: f.file("n.ipynb"), new_source: "x", cell_id: "c1" } }), null);
  assert.deepEqual(JSON.parse(readFileSync(paths.session(f.sd, SESSION), "utf8")).files, ["w.ts", "e.ts", "m.ts", "n.ipynb"].map(f.file));
  assert.equal(f.decision(f.call(f.write("fifth.ts"))), "deny");
});

test("regression: the two real Bash commands that 0.2.0 counted as repository files count nothing", (t) => {
  const f = fixture(t);
  f.setRepo(JSON.stringify({ threshold: 2 }));
  assert.equal(f.call(f.bash(REAL_ABSENT)), null);
  assert.equal(f.call(f.bash(REAL_PIN)), null);
  assert.equal(existsSync(paths.session(f.sd, SESSION)), false); // no file counted, so no record written
  // and one real file still counts after them, then the 2nd is denied
  assert.equal(f.call(f.edit("a.ts")), null);
  assert.equal(f.decision(f.call(f.edit("b.ts"))), "deny");
});
