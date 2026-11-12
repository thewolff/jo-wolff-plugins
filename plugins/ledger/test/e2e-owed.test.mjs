// e2e-owed.test.mjs — the forgotten-work stories through the real CLI and the real hook scripts,
// each a separate process fed the JSON Claude Code sends, over a temp git repository and a temp
// database: a formal approval that the agent leaves unstarted, an offer made in passing that is
// recorded and approved, and a second offer made while a question is already open.

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { sandbox, cli, hook, openDb } from "./helpers.mjs";

const SID = "s-e2e-owed";

function story() {
  const b = sandbox();
  const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: b.work, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const env = { LEDGER_SESSION_ID: SID };
  const transcript_path = join(b.root, "transcript.jsonl");
  appendFileSync(transcript_path, "");
  const run = (args) => {
    const x = cli(b, args, { env });
    assert.equal(x.code, 0, x.out + x.err);
    return x.out;
  };
  const typed = (prompt_id) => appendFileSync(transcript_path, `${JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: new Date().toISOString(), message: { role: "user", content: `prompt ${prompt_id}` } })}\n`);
  const prompt = (text) => hook(b, "user-prompt", { session_id: SID, cwd: b.work, hook_event_name: "UserPromptSubmit", prompt: text });
  const stop = (prompt_id, last_assistant_message) => {
    const x = hook(b, "stop", { session_id: SID, cwd: b.work, hook_event_name: "Stop", prompt_id, stop_hook_active: false, last_assistant_message, transcript_path });
    assert.equal(x.code, 0, x.err);
    return x.json ?? {};
  };
  const bounces = () => {
    const db = openDb(b);
    try {
      return db.prepare("SELECT rule, prompt_id, outcome FROM cc_bounces ORDER BY id").all().map((x) => [x.rule, x.prompt_id, x.outcome]);
    } finally {
      db.close();
    }
  };
  hook(b, "session-start", { session_id: SID, cwd: b.work, hook_event_name: "SessionStart", source: "startup" });
  return { b, run, typed, prompt, stop, bounces };
}

const id = (re, out) => re.exec(out)[0];

test("formal story: ask, a reply on a new topic, the answer recorded, the owed block on the same prompt, then started", () => {
  const { run, typed, prompt, stop, bounces } = story();
  const ask = "I have the plan for the digest. Should I build the weekly digest exporter now?";
  assert.equal(stop("p-1", ask).decision, "block");
  const q = id(/q-[a-z0-9]+/, run(["ask", "Build the weekly digest exporter now?", "--name", "digest-exporter", "--options", "yes,no"]));
  assert.equal(stop("p-1", ask).decision, undefined);
  typed("p-2");
  assert.equal(prompt("sounds good, but first, what does the cache TTL default to?").out, "", "nothing owed yet, nothing said");
  const answerRule = stop("p-2", "The cache TTL defaults to 300 seconds; it is set in config.mjs.");
  assert.match(answerRule.reason, /records the approved work as owed/);
  const ow = id(/ow-[a-z0-9]+/, run(["answer", q, "yes"]));
  const owedBlock = stop("p-2", "Recorded your yes. The TTL is 300 seconds.");
  assert.equal(owedBlock.decision, "block");
  assert.match(owedBlock.reason, /still owed/);
  run(["start", ow, "agent a1b2c3"]);
  const pass = stop("p-2", "Started the exporter build in a background agent.");
  assert.equal(pass.decision, undefined);
  assert.match(pass.systemMessage, /ledger: started: digest-exporter: yes \(agent a1b2c3\)/);
  assert.deepEqual(bounces(), [
    ["stopAskRule", "p-1", "satisfied"],
    ["stopAnswerRule", "p-2", "satisfied"],
    ["stopOwedRule", "p-2", "satisfied"],
  ]);
});

test("offer story: an offer in passing is recorded, the human approves with a question first, the work is owed, then started", () => {
  const { run, typed, stop, bounces } = story();
  const offer = "I can run the scrub over the rest next.";
  const first = stop("p-1", `Scrub done on two reports. ${offer}`);
  assert.equal(first.decision, "block");
  assert.match(first.reason, /offers to do work the human has not approved/);
  const q = id(/q-[a-z0-9]+/, run(["ask", "Run the scrub over the remaining reports?", "--kind", "approval", "--name", "scrub-rest", "--about", offer]));
  assert.equal(stop("p-1", `Scrub done on two reports. ${offer}`).decision, undefined);
  typed("p-2");
  const answerRule = stop("p-2", "The retry default is three attempts with backoff.");
  assert.equal(answerRule.decision, "block");
  const ow = id(/ow-[a-z0-9]+/, run(["answer", q, "approve", "--work", "Run the scrub over the remaining reports"]));
  const owedBlock = stop("p-2", "Approved. The retry default is three attempts.");
  assert.match(owedBlock.reason, /still owed[\s\S]*Run the scrub over the remaining reports/);
  run(["start", ow, "background job 7"]);
  assert.equal(stop("p-2", "Scrub running in background job 7.").decision, undefined);
  assert.deepEqual(bounces().map(([rule, p]) => [rule, p]), [["stopOfferRule", "p-1"], ["stopAnswerRule", "p-2"], ["stopOwedRule", "p-2"]]);
});

test("bypass story: with a question already open, a second, different offer is still blocked", () => {
  const { run, stop, bounces } = story();
  run(["ask", "Which region should the cache use?", "--name", "region", "--options", "east,west"]);
  const r = stop("p-1", "I asked about the region. Next, I could add the missing index.");
  assert.equal(r.decision, "block");
  assert.match(r.reason, /- Next, I could add the missing index\./);
  assert.deepEqual(bounces().map(([rule]) => rule), ["stopOfferRule"]);
});
