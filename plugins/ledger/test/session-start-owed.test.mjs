import test from "node:test";
import assert from "node:assert/strict";
import { buildInjection, CAP } from "../lib/inject.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { sandbox, hook, apply, idOf, openDb, askQuestion } from "./helpers.mjs";

const SID = "s-ss-owed";
const startHook = (box, source = "startup") => hook(box, "session-start", { session_id: SID, cwd: box.work, hook_event_name: "SessionStart", source });
const contextOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";

function fill(box, n, len = 200) {
  const word = (k, i) => `${k}${i} `.padEnd(len, "x");
  apply(box, Array.from({ length: n }, (_, i) => `owe "${word("owed", i)}"`), { sessionId: SID });
  const s = Array.from({ length: n }, (_, i) => idOf(apply(box, `owe "${word("started", i)}"`, { sessionId: SID })));
  apply(box, s.map((id) => `start ${id} "${"p".repeat(len)}"`), { sessionId: SID });
  const d = Array.from({ length: n }, (_, i) => idOf(apply(box, `owe "${word("held", i)}"`, { sessionId: SID })));
  apply(box, d.map((id) => `hold ${id} "${"r".repeat(len)}"`), { sessionId: SID });
  apply(box, Array.from({ length: n }, (_, i) => `owe "${word("theirs", i)}"`), { sessionId: "s-other" });
}

test("SessionStart puts the owed section first and lists other sessions' items as not blocking", () => {
  const box = sandbox();
  startHook(box);
  askQuestion(box, { name: "held-one", options: "a,b" });
  const mine = idOf(apply(box, 'owe "Build the exporter"', { sessionId: SID }));
  const theirs = idOf(apply(box, 'owe "Rotate the key"', { sessionId: "s-other" }));
  const ctx = contextOf(startHook(box, "resume"));
  assert.ok(ctx.startsWith("ledger: owed work for this session (approved by the human, oldest first)"), ctx);
  assert.ok(ctx.includes(`- Build the exporter (${mine}, owed since `), ctx);
  const others = ctx.indexOf("Owed by other sessions in scope (listed, not blocking; moving one takes it over):");
  assert.ok(others > 0 && ctx.indexOf(`- Rotate the key (${theirs}, owed)`) > others, ctx);
  assert.ok(ctx.indexOf("open questions for") > others, "questions come after the owed section");
});

test("compact keeps owed and started, drops held and other sessions' lines", () => {
  const box = sandbox();
  startHook(box);
  fill(box, 2, 20);
  const db = openDb(box);
  const { text, sections } = buildInjection(db, box.work, DEFAULTS, { source: "compact", env: box.env, sessionId: SID });
  db.close();
  assert.equal(sections[0], "owed");
  assert.match(text, /^- owed0 /m);
  assert.match(text, /^Started, not done:$/m);
  assert.doesNotMatch(text, /^Deferred:$/m);
  assert.doesNotMatch(text, /Owed by other sessions/);
});

// The 2,600-character budget in the design does not fit its own caps (25 lines of up to 120 + 80
// characters); that is an open question for the owner. This pins the caps and the CAP bound only.
test("thirty items in every list with 200-character texts: each list keeps its cap and the section fits under CAP", () => {
  const box = sandbox();
  startHook(box);
  fill(box, 30);
  const db = openDb(box);
  const { text } = buildInjection(db, box.work, DEFAULTS, { source: "startup", env: box.env, sessionId: SID });
  db.close();
  const section = text.slice(0, text.indexOf("\n\n") === -1 ? text.length : text.indexOf("\n\n"));
  assert.ok(section.length < CAP, `section is ${section.length} characters`);
  for (const line of section.split("\n")) assert.ok(line.length <= 260, `line too long: ${line.length}`);
  assert.equal(section.split("\n").filter((l) => l.startsWith("- owed")).length, 10);
  assert.equal(section.split("\n").filter((l) => l.startsWith("- started")).length, 5);
  assert.equal(section.split("\n").filter((l) => l.startsWith("- held")).length, 5);
  assert.equal(section.split("\n").filter((l) => l.startsWith("- theirs")).length, 5);
  assert.equal(section.split("\n").filter((l) => l.startsWith("… and ")).length, 4);
});

test("an injection over CAP loses notes first and keeps the owed section whole", () => {
  const box = sandbox();
  startHook(box);
  fill(box, 30);
  apply(box, Array.from({ length: 40 }, (_, i) => `note "${`long note ${i} `.padEnd(400, "n")}"`), { sessionId: SID });
  const db = openDb(box);
  const full = buildInjection(db, box.work, DEFAULTS, { source: "startup", env: box.env, sessionId: SID });
  const config = { ...DEFAULTS, inject: { ...DEFAULTS.inject, notes: 40 } };
  const capped = buildInjection(db, box.work, config, { source: "startup", env: box.env, sessionId: SID });
  db.close();
  const section = full.text.slice(0, full.text.indexOf("\n\n"));
  assert.ok(capped.text.startsWith(section), "the owed section is whole");
  assert.ok(capped.text.length <= CAP, `${capped.text.length} > ${CAP}`);
});

test("no owed work: the injection has no owed section", () => {
  const box = sandbox();
  startHook(box);
  const db = openDb(box);
  const { sections } = buildInjection(db, box.work, DEFAULTS, { source: "startup", env: box.env, sessionId: SID });
  db.close();
  assert.ok(!sections.includes("owed"));
});
