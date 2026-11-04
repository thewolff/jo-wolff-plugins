// Output and size limits, as spawned processes: the runner drains answers larger than a pipe
// buffer before it exits (and gives up at its deadline when the host never reads), and the Due
// block stays inside its bounds however much remindctl returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DIR, sandbox } from "./helpers.mjs";
import { BLOCK_MAX, ITEMS_MAX } from "../lib/due.mjs";

const BIG = join(PLUGIN_DIR, "test", "fixtures", "big-answer-hook.mjs");
const SESSION_START = join(PLUGIN_DIR, "hooks", "session-start.mjs");
const PIPE_BUFFER = 65_536;

const errorsLog = (box) => (existsSync(join(box.stateDir, "errors.log")) ? readFileSync(join(box.stateDir, "errors.log"), "utf8").trim().split("\n").filter(Boolean) : []);

/**
 * `n` reminders as remindctl's JSON, every title `titleLen` characters long and unique. `minimal`
 * keeps only title and dueDate, so 10,000 of them stay under the 1 MiB stdout cap.
 */
function reminders(n, titleLen, { minimal = false } = {}) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const tag = `#${i} `;
    const title = tag + "t".repeat(Math.max(titleLen - tag.length, 0));
    items.push(minimal ? { title, dueDate: "2026-11-04T18:00:00Z" } : { id: `r-${i}`, title, dueDate: "2026-11-04T18:00:00Z", dueDateIsAllDay: false, isCompleted: false });
  }
  return JSON.stringify(items);
}

test("runner: an answer larger than a pipe buffer reaches stdout whole", () => {
  const box = sandbox();
  try {
    for (const bytes of [100_000, 1_048_576]) {
      const r = spawnSync(process.execPath, [BIG], { env: box.env, input: JSON.stringify({ bytes }), maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
      assert.equal(r.status, 0, r.stderr.toString());
      assert.ok(r.stdout.length > PIPE_BUFFER, `stdout was ${r.stdout.length} bytes`);
      const out = JSON.parse(r.stdout.toString("utf8"));
      assert.equal(out.hookSpecificOutput.additionalContext.length, bytes);
    }
    assert.deepEqual(errorsLog(box), []);
  } finally {
    box.release();
  }
});

test("runner: a host that never reads stdout → exit 0 at the deadline, one errors.log line, nothing more written", async () => {
  const box = sandbox({ extra: { HOOK_DEADLINE_MS: "1500" } });
  try {
    const started = Date.now();
    const child = spawn(process.execPath, [BIG], { env: box.env, stdio: ["pipe", "pipe", "ignore"] });
    child.stdin.end(JSON.stringify({ bytes: 8 * 1024 * 1024 }));
    // stdout is never read: the pipe fills and stays full.
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    const ms = Date.now() - started;
    assert.equal(code, 0);
    assert.ok(ms < 2_500, `exited after ${ms} ms`);
    const lines = errorsLog(box);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /^\S+ SessionStart stdout not drained within \d+ ms: the host is not reading it; the rest of a \d+-byte answer was dropped$/);
    child.stdout.destroy();
  } finally {
    box.release();
  }
});

test("SessionStart with 500 reminders of 200 characters → valid JSON, block within BLOCK_MAX, the rest counted", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const big = join(box.root, "big.json");
    writeFileSync(big, reminders(500, 200));
    const empty = join(PLUGIN_DIR, "test", "fixtures", "remindctl-show-empty.json");
    const r = spawnSync(process.execPath, [SESSION_START], { env: { ...box.env, STUB_OVERDUE: big, STUB_TODAY: empty }, input: JSON.stringify({ session_id: "s-big" }), maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr.toString());
    const block = JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
    assert.ok(Buffer.byteLength(block) <= BLOCK_MAX, `block is ${Buffer.byteLength(block)} bytes`);
    const shown = (block.split("\n")[0].match(/#\d+ t/g) ?? []).length;
    assert.ok(shown <= ITEMS_MAX && shown > 0, `${shown} items shown`);
    assert.match(block, new RegExp(`; … and ${500 - shown} more\\n`));
    assert.deepEqual(errorsLog(box), []);
  } finally {
    box.release();
  }
});

test("10,000 due reminders → block within BLOCK_MAX, at most ITEMS_MAX shown, hook under 1 s", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb" } });
  try {
    const huge = join(box.root, "huge.json");
    writeFileSync(huge, reminders(10_000, 12, { minimal: true }));
    assert.ok(readFileSync(huge).length < 1024 * 1024);
    const empty = join(PLUGIN_DIR, "test", "fixtures", "remindctl-show-empty.json");
    const started = Date.now();
    const r = spawnSync(process.execPath, [SESSION_START], { env: { ...box.env, STUB_OVERDUE: huge, STUB_TODAY: empty }, input: JSON.stringify({ session_id: "s-huge" }), maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
    const ms = Date.now() - started;
    assert.equal(r.status, 0, r.stderr.toString());
    const block = JSON.parse(r.stdout.toString("utf8")).hookSpecificOutput.additionalContext;
    assert.ok(Buffer.byteLength(block) <= BLOCK_MAX, `block is ${Buffer.byteLength(block)} bytes`);
    assert.match(block, new RegExp(`; … and ${10_000 - ITEMS_MAX} more\\n`));
    assert.ok(ms < 1_000, `took ${ms} ms`);
    assert.deepEqual(errorsLog(box), []);
  } finally {
    box.release();
  }
});

test("remindctl stdout over 1 MiB → its group is killed, no block, logged, named at SessionStart", () => {
  const box = sandbox({ extra: { REMINDERS_REVIEW_WATCH: "Plumb", STUB_REMINDCTL: "flood" } });
  try {
    const started = Date.now();
    const r = spawnSync(process.execPath, [SESSION_START], { env: box.env, input: JSON.stringify({ session_id: "s-flood" }), encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - started < 2_000);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.match(out.systemMessage, /list Plumb \(remindctl show (overdue|today) wrote more than 1048576 bytes\); fix: /);
    assert.equal(errorsLog(box).length, 1);
    assert.match(errorsLog(box)[0], /list Plumb: size: /);
  } finally {
    box.release();
  }
});

test("buildBlock: lists past BLOCK_MAX are summed up in one closing line; a short block is unchanged", async () => {
  const { buildBlock, BLOCK_NOTE } = await import("../lib/due.mjs");
  const item = (i) => ({ id: `x${i}`, title: `#${i} ${"é".repeat(190)}`, dueDate: null, allDay: false });
  const sections = ["A", "B", "C", "D", "E"].map((list) => ({ list, items: Array.from({ length: 40 }, (_, i) => item(i)) }));
  const block = buildBlock(sections, { now: Date.parse("2026-11-04T10:30:00Z"), timeZone: "America/Los_Angeles" });
  assert.ok(Buffer.byteLength(block) <= BLOCK_MAX, `block is ${Buffer.byteLength(block)} bytes`);
  const lines = block.split("\n");
  assert.equal(lines.at(-1), BLOCK_NOTE);
  assert.match(lines[0], /^Due \(list A\): #0 é+; .*; … and \d+ more$/);
  assert.equal(lines.at(-2), "Due (list E): … and 40 more", "a list with no room left is still named, with its count");
  const shownItems = (block.match(/#\d+ é/g) ?? []).length;
  const counted = [...block.matchAll(/… and (\d+) more|: (\d+) reminders not shown/g)].reduce((n, m) => n + Number(m[1] ?? m[2]), 0);
  assert.equal(shownItems + counted, 200, "every reminder is shown or counted");
  assert.equal(buildBlock([{ list: "A", items: [item(1)] }], {}), `Due (list A): ${item(1).title}\n${BLOCK_NOTE}`);
  // So many lists that not even their heads fit: the rest are summed in one closing line.
  const many = Array.from({ length: 600 }, (_, i) => ({ list: `List ${i}`, items: [item(i)] }));
  const crowded = buildBlock(many, {});
  assert.ok(Buffer.byteLength(crowded) <= BLOCK_MAX, `block is ${Buffer.byteLength(crowded)} bytes`);
  const tail = crowded.split("\n").at(-2).match(/^Due in (\d+) more watched lists: (\d+) reminders not shown$/);
  assert.ok(tail, crowded.split("\n").at(-2));
  assert.equal(Number(tail[1]), Number(tail[2]));
  assert.equal(crowded.split("\n").length - 2 + Number(tail[1]), 600, "every list is a line or counted");
});
