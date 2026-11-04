// The findings file (README "Findings on disk"): the parser on real-shaped replies, the Stop hook
// writing it on real Claude Code 2.1.317 payloads (fixtures/claude-code/), its faults, and prune.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFindings } from "../skills/ask-graham/scripts/findings.mjs";
import { findingsDir, handle, writeFindings } from "./ask-graham-stop.mjs";
import { prune } from "../scripts/prune.mjs";
import { claudeCode } from "../fixtures/transcripts.mjs";
import { STOP_HOOK, reply, spawnScript } from "../fixtures/run-hook.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "claude-code");
// A captured Stop payload, its transcript_path pointed at the transcript as it stood at that stop.
const payload = (name) => ({
  ...JSON.parse(readFileSync(join(DIR, name), "utf8")),
  transcript_path: join(DIR, name.replace(".payload.json", ".transcript.jsonl")),
});
const realReply = (name) => payload(name).last_assistant_message;

function env(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-findings-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  const state = join(base, "state");
  return {
    base,
    repo,
    vars: { HOME: base, XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(base, "config") },
    dir: join(state, "ask-graham", "findings"),
    errorsLog: join(state, "ask-graham", "errors.log"),
  };
}

const stop = (e, p) => {
  const r = spawnScript(STOP_HOOK, { input: { ...p, cwd: e.repo }, env: e.vars });
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0, r.stderr);
  return reply(r);
};

// The two 0.8.0 session scenarios' reply shapes (evals/session-alternative-*.scenario.json).
const SHOWN = [
  "**Verdict:** start now. Add scripts/archive.mjs and parse config.json the way the three scripts do.",
  "",
  "**Gate questions** (Graham #1)",
  "- Why: exports pile up",
  "",
  "**Red flags:** second pattern: fires (scripts/export.mjs:4, scripts/import.mjs:3 each parse config.json)",
  "",
  "**Alternative:** `one shared loader in lib/config.mjs`: one place for the missing-file handling; costs migrating the three scripts",
  "",
  "**Closing ask:** add archive.mjs now?",
].join("\n");
const NONE = SHOWN.replace(/\*\*Alternative:\*\*.*$/m, "**Alternative:** *none*: archive.mjs imports loadConfig like every script; nothing beats it");
const STRUCTURE = [
  "**Structure check:** a new `story_tags` table",
  "**Found:** two overlaps",
  "- story_labels (migrations/0012_labels.sql:3): same parent, same job",
  "- stories.tags column (migrations/0004_stories.sql:9): a jsonb list",
  "",
  "**Red flags:** second pattern: fires (story_labels)",
  "",
  "**Alternative:** reuse story_labels; fewer tables; costs a rename",
].join("\n");

test("a real verdict reply: kind, verdict, and the verdict's design as the chosen alternative", () => {
  const f = parseFindings(realReply("new-idea.Stop-1.payload.json"));
  assert.equal(f.kind, "verdict");
  assert.equal(f.verdict, "do it now");
  assert.equal(f.ask, null);
  assert.equal(f.alternative, null);
  assert.deepEqual(f.found, []);
  assert.equal(f.alternatives.length, 1);
  assert.equal(f.alternatives[0].chosen, true);
  assert.match(f.alternatives[0].design, /^but only the small version: a one-line git alias/);
  const second = parseFindings(realReply("new-idea.Stop-2.payload.json"));
  assert.match(second.alternatives[0].design, /^A one-line `git weekly` alias/);
});

test("a reply with no label lines, a waiting reply, a fenced template and a lower-case label give nothing", () => {
  assert.equal(parseFindings(realReply("no-verdict.Stop-1.payload.json")), null);
  assert.equal(parseFindings("**Ask:** a cache\n\n**Gate questions** (Graham #1)\n- Why: speed\n\nDo you want me to research and see if something comparable exists?"), null);
  assert.equal(parseFindings("The template:\n```\n**Verdict:** do it now. x\n```\n"), null);
  assert.equal(parseFindings("**verdict:** do it now. x"), null);
  assert.equal(parseFindings("Verdict: do it now. x"), null);
  assert.equal(parseFindings(undefined), null);
});

test("the alternative-shown shape: the pattern-fit design chosen, the better one beside it", () => {
  const f = parseFindings(SHOWN);
  assert.equal(f.verdict, "start now");
  assert.match(f.alternative, /^`one shared loader/);
  assert.deepEqual(f.alternatives, [
    { design: "Add scripts/archive.mjs and parse config.json the way the three scripts do.", chosen: true },
    { design: "one shared loader in lib/config.mjs`: one place for the missing-file handling; costs migrating the three scripts", chosen: false },
  ]);
});

test("the alternative-none shape: the line is kept, no unchosen design is added", () => {
  for (const none of ["*none*: weighed x", "none: weighed x", "`n/a`", "nothing beats it", "No better design", "\"not a technical ask\""]) {
    const f = parseFindings(SHOWN.replace(/\*\*Alternative:\*\*.*$/m, `**Alternative:** ${none}`));
    assert.equal(f.alternative, none);
    assert.deepEqual(f.alternatives.map((a) => a.chosen), [true], none);
  }
  assert.equal(parseFindings(NONE).alternatives.length, 1);
  assert.equal(parseFindings(SHOWN.replace(/\*\*Alternative:\*\*.*$/m, "**Alternative:** nonexistent cache layer, faster")).alternatives.length, 2);
});

test("a structure check: its found items, no verdict, the alternative unchosen", () => {
  const f = parseFindings(STRUCTURE);
  assert.equal(f.kind, "structure-check");
  assert.equal(f.verdict, null);
  assert.deepEqual(f.found, [
    "two overlaps",
    "story_labels (migrations/0012_labels.sql:3): same parent, same job",
    "stories.tags column (migrations/0004_stories.sql:9): a jsonb list",
  ]);
  assert.deepEqual(f.alternatives, [{ design: "reuse story_labels; fewer tables; costs a rename", chosen: false }]);
  assert.deepEqual(parseFindings("**Structure check:** a column\n**No similar:** searched migrations/").found, []);
});

test("labels tolerate list markers, headings, colon outside the bold, emphasis and curly apostrophes", () => {
  assert.equal(parseFindings("- **Verdict**: **don’t build**, it exists").verdict, "don't build");
  assert.equal(parseFindings("## __Verdict:__ _later_. after the launch").alternatives[0].design, "after the launch");
  assert.equal(parseFindings("**Ask:** a cache for X\n\n**Verdict:** later").ask, "a cache for X");
  assert.deepEqual(parseFindings("**Verdict:** later").alternatives, []);
  assert.equal(parseFindings("**Verdict:** maybe. hmm").verdict, null);
});

test("the Stop hook writes the real verdict reply's findings, 0600, with the payload's session and cwd", (t) => {
  const e = env(t);
  const p = payload("new-idea.Stop-1.payload.json");
  stop(e, p);
  const path = join(e.dir, `${p.session_id}.json`);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(rec), ["version", "sessionId", "writtenAt", "kind", "ask", "verdict", "alternative", "alternatives", "found", "cwd"]);
  assert.equal(rec.version, 1);
  assert.equal(rec.sessionId, p.session_id);
  assert.equal(rec.cwd, e.repo);
  assert.equal(rec.verdict, "do it now");
  assert.ok(!Number.isNaN(Date.parse(rec.writtenAt)));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(e.dir), [`${p.session_id}.json`], "no tmp file left");
  assert.equal(existsSync(e.errorsLog), false);
  // the next stop of the session replaces it
  stop(e, payload("new-idea.Stop-2.payload.json"));
  assert.match(JSON.parse(readFileSync(path, "utf8")).alternatives[0].design, /^A one-line `git weekly` alias/);
});

test("a real reply with no label lines writes no file and no error", (t) => {
  const e = env(t);
  const out = stop(e, payload("no-verdict.Stop-1.payload.json"));
  assert.equal(out.decision, "block");
  assert.equal(existsSync(e.dir), false);
  assert.equal(existsSync(e.errorsLog), false);
});

test("without last_assistant_message the transcript's reply is recorded", (t) => {
  const e = env(t);
  const p = { ...payload("new-idea.Stop-1.payload.json"), transcript_path: join(DIR, "new-idea.transcript.jsonl") };
  delete p.last_assistant_message;
  stop(e, p);
  assert.equal(JSON.parse(readFileSync(join(e.dir, `${p.session_id}.json`), "utf8")).verdict, "do it now");
});

test("stop-check=off still records the findings", (t) => {
  const e = env(t);
  mkdirSync(join(e.base, "config", "ask-graham"), { recursive: true });
  writeFileSync(join(e.base, "config", "ask-graham", "config"), "stop-check=off\n");
  const p = payload("new-idea.Stop-1.payload.json");
  assert.equal(stop(e, p), null);
  assert.ok(existsSync(join(e.dir, `${p.session_id}.json`)));
});

test("a findings write that fails is one errors.log line, never a block or a changed decision", (t) => {
  const e = env(t);
  mkdirSync(dirname(e.dir), { recursive: true });
  writeFileSync(e.dir, "not a directory");
  const out = stop(e, payload("new-idea.Stop-1.payload.json"));
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /findings .* could not be written/);
  const lines = readFileSync(e.errorsLog, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ask-graham-stop\.mjs findings .* could not be written \((ENOTDIR|EEXIST)\)/);
  // a reply the check blocks is still blocked when the findings cannot be written
  const cc = claudeCode();
  cc.prompt("should we build a cache?");
  cc.skill("ask-graham:ask-graham", "should we build a cache");
  const transcript = join(e.base, "t.jsonl");
  writeFileSync(transcript, cc.jsonl());
  const faults = [];
  const r = handle(
    { session_id: "s1", transcript_path: transcript, cwd: e.repo, last_assistant_message: "**Structure check:** a new table\n**Found:** nothing close" },
    { env: e.vars, home: e.base, fault: (x) => faults.push(x) },
  );
  assert.equal(r.decision, "block");
  assert.equal(faults.length, 1);
});

test("writeFindings: a write that throws is a fault, never thrown", (t) => {
  const e = env(t);
  const faults = [];
  const ro = join(e.base, "ro");
  mkdirSync(ro, { recursive: true, mode: 0o500 });
  t.after(() => rmSync(ro, { recursive: true, force: true }));
  const got = writeFindings("**Verdict:** later", { sessionId: "s", cwd: "/", env: { XDG_STATE_HOME: join(ro, "nested") }, home: e.base, fault: (x) => faults.push(x) });
  assert.equal(got, null);
  if (process.getuid?.() !== 0) assert.equal(faults.length, 1);
  assert.equal(existsSync(join(ro, "nested")), false);
  assert.equal(writeFindings("noted", { sessionId: "s", cwd: "/", env: e.vars, home: e.base, fault: (x) => faults.push(x) }), null);
});

test("findingsDir follows the state directory rule", () => {
  assert.equal(findingsDir({ XDG_STATE_HOME: "/x/state" }, "/home/me"), "/x/state/ask-graham/findings");
  assert.equal(findingsDir({ XDG_STATE_HOME: "rel" }, "/home/me"), "/home/me/.local/state/ask-graham/findings");
});

test("prune removes findings older than 30 days and keeps fresh ones and errors.log", (t) => {
  const e = env(t);
  const root = dirname(e.dir);
  mkdirSync(e.dir, { recursive: true });
  const old = join(e.dir, "old.json");
  const fresh = join(e.dir, "fresh.json");
  writeFileSync(old, "{}\n");
  writeFileSync(fresh, "{}\n");
  writeFileSync(join(root, "errors.log"), "x\n");
  const now = Date.now();
  const past = new Date(now - 31 * 24 * 3_600_000);
  utimesSync(old, past, past);
  utimesSync(join(root, "errors.log"), past, past);
  const r = prune(root, { days: 30, now });
  assert.deepEqual(r, { removed: 1, bytes: 3, kept: 2 });
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(fresh));
  assert.ok(existsSync(join(root, "errors.log")));
});
