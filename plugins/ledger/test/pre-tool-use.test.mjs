import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { sandbox, hook, cli, openDb, count } from "./helpers.mjs";
import { subcommands, isPush, isPrCreate, writeIsOutside } from "../lib/gate.mjs";

const box = sandbox();
const bash = (command) => ({ session_id: "s", cwd: box.work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
const write = (file_path, tool_name = "Write") => ({ session_id: "s", cwd: box.work, hook_event_name: "PreToolUse", tool_name, tool_input: { file_path } });
const askTool = () => ({ session_id: "s", cwd: box.work, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [] } });

function denied(r, rule) {
  assert.equal(r.code, 0, r.err);
  assert.ok(r.json, `expected JSON, got ${JSON.stringify(r.out)}`);
  assert.equal(r.json.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(r.json.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, rule);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /node \S*scripts\/ledger\.mjs (open|ask)/);
}
function allowed(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "", `expected no output, got ${r.out}`);
}

test("step 7: push shapes are denied with a reason naming `ledger open`; the db has no workload", () => {
  for (const c of ["git push origin main", "FOO=1 git -C /x push", "npm test && git push", "echo $(git push)", "git push --force-with-lease\n", "cd sub; git push", "git -c push.default=current push"]) {
    denied(hook(box, "pre-tool-use", bash(c)), /git push denied — no open workload/);
  }
  const db = openDb(box);
  assert.equal(count(db, "workloads"), 0);
  db.close();
});

test("step 7: non-push git and quoted strings pass with no output", () => {
  for (const c of ["git pushup", 'echo "git push"', "git status", "git log --oneline -5 main", "echo 'npm && git push'", "git commit -m 'push it'"]) {
    allowed(hook(box, "pre-tool-use", bash(c)));
  }
});

test("step 7: gh pr create is denied, gh pr view passes", () => {
  denied(hook(box, "pre-tool-use", bash("gh pr create --fill")), /gh pr create denied/);
  denied(hook(box, "pre-tool-use", bash("git push -u origin x && gh pr create --title t")), /git push denied/);
  allowed(hook(box, "pre-tool-use", bash("gh pr view 12")));
  allowed(hook(box, "pre-tool-use", bash("gh pr list")));
});

test("step 7: Write to a sibling directory is denied; under cwd, under os.tmpdir(), and under the scratchpad dir it passes", () => {
  denied(hook(box, "pre-tool-use", write(join(box.sibling, "x.txt"))), /outside .* and no workload is open here/);
  denied(hook(box, "pre-tool-use", write(join(box.sibling, "new", "deeper", "x.txt"), "Edit")), /outside/);
  denied(hook(box, "pre-tool-use", { ...write(join(box.sibling, "n.ipynb"), "NotebookEdit"), tool_input: { notebook_path: join(box.sibling, "n.ipynb") } }), /outside/);
  allowed(hook(box, "pre-tool-use", write(join(box.work, "src", "a.ts"))));
  allowed(hook(box, "pre-tool-use", write(join(box.work, "a.ts"), "MultiEdit")));
  allowed(hook(box, "pre-tool-use", write(join(box.root, "tmp", "ledger-x", "a.txt"))));
  // /tmp is exempt unless the sandbox itself sits under it (Linux: os.tmpdir() is /tmp), when it covers every sibling and is not.
  const underTmp = realpathSync(box.work).startsWith(`${realpathSync("/tmp")}/`);
  (underTmp ? denied : allowed)(hook(box, "pre-tool-use", write("/tmp/anything.txt")), /outside/);
  allowed(hook(box, "pre-tool-use", { ...write(join(box.root, "scratch", "s.md")), scratchpad_dir: join(box.root, "scratch") }));
  allowed(hook(box, "pre-tool-use", { ...write(undefined), tool_input: {} }));
});

test("step 7: AskUserQuestion with no open q- row is denied, naming the ledger ask", () => {
  denied(hook(box, "pre-tool-use", askTool()), /ask the question through the ledger first/);
});

test("step 7: after ledger open in the cwd every one of the above is allowed; AskUserQuestion still needs a q- row", () => {
  const b = sandbox();
  cli(b, ["open", "gate open"]);
  const inB = (p) => ({ ...p, cwd: b.work });
  for (const c of ["git push origin main", "npm test && git push", "gh pr create --fill"]) allowed(hook(b, "pre-tool-use", inB(bash(c))));
  allowed(hook(b, "pre-tool-use", inB(write(join(b.sibling, "x.txt")))));
  const r = hook(b, "pre-tool-use", inB(askTool()));
  denied(r, /through the ledger first/);
  cli(b, ["ask", "Which?", "--name", "w", "--options", "a,b"]);
  allowed(hook(b, "pre-tool-use", inB(askTool())));
});

test("step 7: a halted workload denies with the `open wl-…` that lifts it; a workload opened in an ancestor folder covers a subfolder", () => {
  const b = sandbox();
  const open = cli(b, ["open", "halted"]);
  const wl = /wl-[a-z0-9]+/.exec(open.out)[0];
  cli(b, ["halt", wl]);
  const r = hook(b, "pre-tool-use", { ...bash("git push"), cwd: b.work });
  denied(r, new RegExp(`${wl} is halted \\(halted by .*\\); .*ledger\\.mjs open ${wl}`));
  cli(b, ["open", wl]);
  const sub = join(b.work, "packages", "api");
  globalThis.process.getBuiltinModule("node:fs").mkdirSync(sub, { recursive: true });
  allowed(hook(b, "pre-tool-use", { ...bash("git push"), cwd: sub }));
});

test("step 7: forcing.denyPush false → git push allowed while gh pr create still denied; hooks.preToolUse false → nothing at all", () => {
  const b = sandbox();
  b.writeConfig({ forcing: { denyPush: false } });
  allowed(hook(b, "pre-tool-use", { ...bash("git push"), cwd: b.work }));
  denied(hook(b, "pre-tool-use", { ...bash("gh pr create"), cwd: b.work }), /gh pr create denied/);
  b.writeConfig({ hooks: { preToolUse: false } });
  allowed(hook(b, "pre-tool-use", { ...bash("git push"), cwd: b.work }));
  allowed(hook(b, "pre-tool-use", { ...askTool(), cwd: b.work }));
});

test("subcommands: splits on operators outside quotes, lifts $() and backticks, strips assignments", () => {
  assert.deepEqual(subcommands("npm test && git push"), ["npm test", "git push"]);
  assert.deepEqual(subcommands('echo "a && b" | FOO=1 BAR="x y" git push'), ['echo "a && b"', "git push"]);
  assert.deepEqual(subcommands("echo $(git push) `ls`"), ["git push", "ls", "echo $(…) `…`"]);
  assert.deepEqual(subcommands("a; b\nc || d & e"), ["a", "b", "c", "d", "e"]);
  assert.ok(isPush("git push"));
  assert.ok(isPush("git -C /x push origin"));
  assert.ok(!isPush("git pushup"));
  assert.ok(!isPush('echo "git push"'));
  assert.ok(isPrCreate("gh pr create --web"));
  assert.ok(!isPrCreate("gh pr view"));
});

test("writeIsOutside compares realpaths and the nearest existing ancestor", () => {
  const tmpDirs = [join(box.root, "tmp")];
  assert.equal(writeIsOutside(join(box.work, "new", "deep", "f.txt"), box.work, { tmpDirs }), false);
  assert.equal(writeIsOutside(join(box.sibling, "f.txt"), box.work, { tmpDirs }), true);
  assert.equal(writeIsOutside(join(box.root, "f.txt"), box.work, { tmpDirs }), true);
  assert.equal(writeIsOutside(join(box.root, "tmp", "f.txt"), box.work, { tmpDirs }), false);
  // The sandbox itself lives under os.tmpdir(), so for this cwd the default temp exemption does not apply:
  // an exempt folder that contains the cwd is not exempt (a project checked out under /tmp).
  assert.equal(writeIsOutside(join(tmpdir(), "f.txt"), box.work), true);
  assert.equal(writeIsOutside(join(box.root, "elsewhere", "f.txt"), box.work, { tmpDirs: [box.root] }), true);
  assert.equal(writeIsOutside(join(box.root, "elsewhere", "f.txt"), box.work, { tmpDirs: [join(box.root, "elsewhere")] }), false);
  assert.equal(writeIsOutside("relative/f.txt", box.work, { tmpDirs }), writeIsOutside(join(process.cwd(), "relative", "f.txt"), box.work, { tmpDirs }));
});
