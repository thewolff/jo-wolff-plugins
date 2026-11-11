// receipt-blocks.test.mjs — node --test
//
// An output-types receipt block (a bold **CLAIM** or **CITE** label line and the evidence under
// it) backs the point made around it; it is not a message of its own. Until 1.7.2 the Stop hook
// judged each receipt block alone for conclusion-first and bad-news-first, and the judge read
// the receipt (a path, a command, a byte count) as setup burying the point. A blind re-measure
// on 2026-11-10 traced every conclusion-first false alarm, on two judge models, to that shape.
//
// The four messages below are paraphrases of those false alarms, with names, paths and figures
// replaced; each keeps the original's layout and the line its receipt label sat on. The stub
// judge reproduces the measured failure: it convicts conclusion-first whenever the opening
// window it is shown starts in a receipt (RECEIPT_TOKEN sits in every receipt's first line and
// in no message head). So a receipt block judged alone fails these tests, and the whole message
// judged as one unit passes them.
//
// The controls prove the change removes no judging: late bad news under a structural
// `## Needs you` heading is still judged and flagged, and bad news written only inside a receipt
// block is judged against the message it belongs to.
//
// Run: node --test 'plugins/i-have-audhd/hooks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./i-have-audhd-stop.mjs", import.meta.url));
const RECEIPT_TOKEN = "zq-receipt";

// ─── the four false-alarm shapes (judge-remeasure 2026-11-10), paraphrased ────

// m012: a one-paragraph answer, then a CLAIM at line 3 whose receipt is a list of file and line
// ranges, then two unlabeled paragraphs that draw the design conclusion.
const parserAnswer = [
  "Very little. Each parser is ten to thirty lines that walk one response shape into rows, and the only cleaning is dropping non-numeric values and sorting by date. The hard part of the demo was not in the parsers.",
  "",
  "**CLAIM**",
  `From \`src/${RECEIPT_TOKEN}/sources.ts\` (about 500 lines in all, roughly 120 of them the six parsers plus one shared grouping helper):`,
  "",
  "- `parseJsonFeed` (lines 270-284): parse, take the data array, map series, period and a numeric value. Twelve lines.",
  "- `parseCsvFeed` (287-304): split on commas and take the second-to-last cell, because the description column holds commas. Sixteen lines, with that quirk hard-coded by position.",
  "- `groupRows` (306-315), shared: drop rows whose value is not finite, group by series, sort by date string. This is the whole cleaning step, and it is where a month reported as a dash silently disappears.",
  "- `parseLaborFeed` (340-368): check the status field, keep only real months (drops the annual average), build the date, convert the value. Twenty-six lines.",
  "- `parseRatesCsv` (403-414): map observations and treat zero and negatives as missing, which is wrong for any series that can legitimately be zero.",
  "",
  "What the parsers do not do: units, seasonal adjustment, base periods, footnotes, revisions or pagination. That is either assumed by the hand-written catalog or ignored, and the real logic lives in the analysis module.",
  "",
  "So for the production design: the transport-and-parse layer per format family is small and mechanical, which is why the first option is cheap, and the per-dataset metadata the prototype typed by hand is the part that grows.",
].join("\n");

// m026: a `## Needs you` head, a `## Body` paragraph, then a CLAIM at line 8 whose receipt is one
// `ls -la` line, followed by unlabeled tables and a closing ask.
const browserShareReport = [
  "## Needs you",
  "- **The analytics tool's device breakdown counts app users as mobile website visitors.** It shows about 1,000 mobile visitors in the last 30 days, but roughly 700 of them are app screen events. Anyone reading the device mix off that dashboard will overstate mobile web; nothing is broken today.",
  "- **The last 30 days do not reflect the 90-day mobile picture.** Over 90 days an in-app browser led mobile, because of a two-week spike in late summer. The figures below show traffic after that spike.",
  "",
  "## Body",
  "The report is written to a local folder and was not published anywhere. Nobody has opened it in a browser yet, so the layout is unchecked. Undo: delete that folder.",
  "",
  "**CLAIM**",
  `\`ls -la reports/${RECEIPT_TOKEN}/\` shows \`index.html\` (14,200 bytes) and \`index.css\` (13,900 bytes), both written Mar 3 09:15.`,
  "",
  "The numbers below come from the agent's queries; its report included each query and the rows it returned, and I have not re-run them.",
  "",
  "| Device | Visitors | Share |",
  "|---|---|---|",
  "| Desktop | 600 | 60.0% |",
  "| Mobile | 400 | 40.0% |",
  "",
  "By operating system, mobile is about four fifths iOS, so for practical purposes most mobile visitors use one browser engine.",
  "",
  "## Closing ask",
  "Should desktop browser shares be calculated out of all desktop visitors or only those with a recorded browser? I recommend all of them, which is how the report is built now, because it keeps the likely-bot visitors visible as their own row.",
].join("\n");

// m036: retired ACTION and PMDW labels (plain prose since output-types 0.2.0), a card read-back,
// then a one-line CLAIM at line 13 and the QUESTION carrying the ask after it.
const pairingCard = [
  "**ACTION**",
  "`pair_note earlierRoadmap=pick-up` recorded; the README item is carried into this session, still not ready. Reversal: a new roadmap marking it dropped.",
  "",
  "**PMDW**",
  "Card proposed for the path-guard test. Read-back:",
  "",
  "**Card card-2: test the `.git/` path guard**",
  "- **Boundary:** `.git/config` only.",
  "- **Why now:** the first edit was refused by the no-open-card gate before any path check ran, so the guard was never exercised.",
  "- **Effect:** expected refusal, zero changes. If the guard does not fire, one comment line lands in `.git/config` and I remove it inside the same change set.",
  "- **Checks:** the refusal names the guard; otherwise revert and confirm the config still lists cleanly.",
  "",
  "**CLAIM**",
  `Card snapshot \`${RECEIPT_TOKEN}.json\` shows \`.git/config: "absent"\` (verbatim from the propose output): the pairing snapshot excludes \`.git\`, so the harness has no hash for it, itself a hint the path is outside what pairing tracks.`,
  "",
  "**QUESTION**",
  "Agree to card-2 so I run the edit on `.git/config`, or skip the guard test and move on to the documentation card? I recommend agreeing, because it answers the question you asked and costs one refused edit at most.",
].join("\n");

// m068: an ACTION and a QUESTION, a `## Phase 1` heading, then a current-code CLAIM at line 13
// followed by a GUESS proposal and a second QUESTION that carries the decision.
const pairingPhaseOne = [
  "**ACTION**",
  "I called `pair_start` and it was refused: another write gate is loaded in this session, so this adapter stays off. The pairing gate is off, so nothing technically blocks my writes right now.",
  "",
  "**QUESTION**",
  "How do you want to pair given that? Two options:",
  "- **Conversation mode.** The same phases and cards, and I only write after you agree to a card, but nothing enforces it.",
  "- **Unload the other gate.** You remove the conflicting gate and restart, so the pairing gate actually blocks writes outside agreed changes.",
  "",
  "I will hold off on any writes until you pick.",
  "",
  "## Phase 1: define the work",
  "",
  "**CLAIM**",
  `Here is the current code. \`${RECEIPT_TOKEN}/greet.mjs:1-3\` is a one-line \`greet(name)\` that returns a greeting, and the test file has one case checking that greeting.`,
  "",
  "**GUESS(inference)**",
  "Proposed outcome: an options flag returns the whole greeting in uppercase, the one-argument call behaves exactly as now, no new dependencies, and one new test case runs alongside the existing one.",
  "",
  "**QUESTION**",
  "Should the flag be an options object or a plain second argument? An options object reads clearly at the call site and leaves room for more options later; a bare boolean is shorter but says nothing where it is called. I am proposing the options object.",
  "",
  "Confirm or change these points and pick a mode, and I will read through the code without changing anything and come back with a roadmap.",
].join("\n");

const FALSE_ALARMS = [
  { id: "m012", text: parserAnswer, claimLine: 3 },
  { id: "m026", text: browserShareReport, claimLine: 8 },
  { id: "m036", text: pairingCard, claimLine: 13 },
  { id: "m068", text: pairingPhaseOne, claimLine: 13 },
];

// ─── harness ─────────────────────────────────────────────────────────────────

function mkhome() {
  const home = mkdtempSync(join(tmpdir(), "audhd-receipt-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function runHook(payload, home) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      I_HAVE_AUDHD_ENFORCE: "",
      I_HAVE_AUDHD_PROFILE: "",
      I_HAVE_AUDHD_HARNESS: "",
      I_HAVE_AUDHD_NO_GH_FILL: "1",
      XDG_CONFIG_HOME: "",
    },
    timeout: 10_000,
  });
}

const judgedLogPath = (home) => join(home, "judged.jsonl");

// The stub judge. It records every prompt (rule, question, judged message) and answers like the
// judges measured on 2026-11-10: conclusion-first is a violation when the reader's opening window
// starts in a receipt; bad-news-first is a violation when the judged message says "failed" and
// its opening window does not.
function stubJudgeProfile(home, mode) {
  const judge = join(home, "stub-judge.mjs");
  writeFileSync(
    judge,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'const prompt = readFileSync(0, "utf8");',
      'const rule = (/^Rule: (.*)$/m.exec(prompt) ?? [])[1] ?? "";',
      'const question = (/^Question: (.*)$/m.exec(prompt) ?? [])[1] ?? "";',
      'const window = (/The reader\'s first \\d+ words here are: "(.*)"\\./.exec(question) ?? [])[1] ?? "";',
      'const open = prompt.indexOf("<<<MSG\\n") + "<<<MSG\\n".length;',
      'const message = prompt.slice(open, prompt.lastIndexOf("\\nMSG"));',
      `appendFileSync(${JSON.stringify(judgedLogPath(home))}, JSON.stringify({ rule, question, window, message }) + "\\n");`,
      "let violation = false;",
      `if (rule === "conclusion-first") violation = window.includes(${JSON.stringify(RECEIPT_TOKEN)});`,
      'if (rule === "bad-news-first") violation = /\\bfailed\\b/.test(message) && !/\\bfailed\\b/.test(window);',
      'process.stdout.write(JSON.stringify({ violation, reason: violation ? "opening buries the point" : "opening states the point" }));',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(home, ".claude", "i-have-audhd.json"),
    JSON.stringify({ enforcement: { ...(mode ? { mode } : {}), judgeCommand: `node ${judge}` } }),
  );
}

const judged = (home, rule) =>
  (existsSync(judgedLogPath(home)) ? readFileSync(judgedLogPath(home), "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((j) => j.rule === rule);

const warned = (home, rule) => {
  const p = join(home, ".claude", ".i-have-audhd-state", "warnings.log");
  return (existsSync(p) ? readFileSync(p, "utf8") : "").split("\n").filter((l) => l.includes(` rule=${rule} `));
};

// ─── receipt blocks are not judge units ──────────────────────────────────────

for (const { id, text, claimLine } of FALSE_ALARMS) {
  test(`${id}: the CLAIM receipt at line ${claimLine} is judged inside the whole message, never alone`, () => {
    assert.equal(text.split("\n")[claimLine - 1], "**CLAIM**", "fixture keeps the measured label line");
    const home = mkhome();
    stubJudgeProfile(home);
    const r = runHook({ session_id: `${id}-cf`, last_assistant_message: text }, home);
    assert.equal(r.status, 0, r.stderr);
    const jobs = judged(home, "conclusion-first");
    assert.equal(jobs.length, 1, `one conclusion-first job, not one per receipt block: ${jobs.map((j) => j.window).join(" | ")}`);
    assert.equal(jobs[0].message, text, "the judged unit is the whole message, receipt included");
    assert.ok(!jobs[0].question.includes("labeled section"), jobs[0].question);
    assert.ok(!jobs[0].window.includes(RECEIPT_TOKEN), `the opening window is the message head: ${jobs[0].window}`);
    assert.deepEqual(warned(home, "conclusion-first"), [], "no conclusion-first false alarm");
  });
}

// ─── controls: judging is narrowed, not dropped ──────────────────────────────

test("control: late bad news under a `## Needs you` heading is still judged and flagged in a message that carries a receipt", () => {
  const msg = [
    "## Needs you",
    "",
    "The release notes are drafted and the staging deploy went out on schedule this morning with the new search index, the refreshed onboarding copy and the retry change for the importer, and after all of that the nightly migration failed on step four and left the index three rows short.",
    "",
    "**CLAIM**",
    "`git log -1 --format=%h` prints `abc1234`, the commit staging runs.",
    "",
    "The rest of the release is ready for review whenever the migration question is settled.",
  ].join("\n");
  const home = mkhome();
  stubJudgeProfile(home, "block");
  const r = runHook({ session_id: "ctl-bn", last_assistant_message: msg }, home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(judged(home, "bad-news-first").length >= 1, "bad-news-first is still judged");
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  const rules = JSON.parse(
    readFileSync(join(home, ".claude", ".i-have-audhd-state", "last-blocked-ctl-bn.json"), "utf8"),
  ).rules.split(",");
  assert.ok(rules.includes("bad-news-first"), `flagged: ${rules}`);
});

test("bad news written only inside a receipt block is judged against the message it backs, and flagged when the head buries it", () => {
  const msg = [
    "The release branch is cut and the staging deploy went out on schedule this morning with the new search index, the refreshed onboarding copy and the importer retry change, and the review checklist is filled in for every item on it.",
    "",
    "**CLAIM**",
    "`npm test` exited 1: 3 of 40 tests failed, all in the importer retry suite, each on a timeout after 5000 ms.",
  ].join("\n");
  const home = mkhome();
  stubJudgeProfile(home);
  const r = runHook({ session_id: "rb-bn", last_assistant_message: msg }, home);
  assert.equal(r.status, 0, r.stderr);
  const jobs = judged(home, "bad-news-first");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message, msg, "the receipt is judged inside the whole message");
  assert.equal(warned(home, "bad-news-first").length, 1, "the head buries the failure: flagged");
});
