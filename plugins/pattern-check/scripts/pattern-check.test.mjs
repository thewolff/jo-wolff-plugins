import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, run } from "./pattern-check.mjs";
import { paths, stateDir, writeCurrent } from "./lib/state.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "pattern-check.mjs");
const SESSION = "0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10";
// The better design cell and the five fail cells of a well-formed row.
const DESIGN = "none: weighed a shared helper, one caller";
const FAIL = "throws, caller logs to stderr | rerun after fixing input | yes: pure | n/a: no retries | stderr line";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-cli-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = join(base, "state");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git", "info"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(base, "config") };
  const sd = stateDir(env, base);
  const cli = (args, opts = {}) => run(args, { env, home: base, cwd: join(repo, "src"), stdin: null, ...opts });
  const spawn = (args, input = null) => spawnSync(process.execPath, [CLI, ...args], { cwd: join(repo, "src"), input: input ?? "", env: { ...process.env, HOME: base, ...env }, encoding: "utf8", timeout: 5000 });
  return { base, repo, env, sd, cli, spawn };
}

test("parseArgs: command, positional, flags; a flag without a value and an unknown flag throw", () => {
  assert.deepEqual(parseArgs(["open", "a", "retry", "helper", "--session", "s", "--cwd", "/x"]), { command: "open", positional: ["a", "retry", "helper"], session: "s", cwd: "/x", rows: [], noNewPieces: null, days: null, dryRun: false });
  assert.equal(parseArgs(["prune", "--days", "7"]).days, 7);
  assert.throws(() => parseArgs(["prune", "--days", "week"]), /whole number of days/);
  assert.deepEqual(parseArgs(["record", "--row", "a | b | reuse | c", "--row", "d | e | new | f"]).rows, ["a | b | reuse | c", "d | e | new | f"]);
  assert.equal(parseArgs(["record", "--no-new-pieces", "copy edit"]).noNewPieces, "copy edit");
  assert.throws(() => parseArgs(["record", "--row"]), /needs a value/);
  assert.throws(() => parseArgs(["record", "--bogus"]), /unknown option/);
});

test("prune removes receipts, stop guards and session files older than --days (default 30); errors.log and current/ stay", (t) => {
  const f = fixture(t);
  const now = Date.now();
  const old = new Date(now - 40 * 86_400_000);
  const seed = (rel, mtime) => {
    const file = join(f.sd, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x");
    if (mtime) utimesSync(file, mtime, mtime);
    return file;
  };
  const oldReceipt = seed("receipts/a.md", old);
  const oldStop = seed("stop/s", old);
  const oldSession = seed("sessions/s.json", old);
  const fresh = seed("receipts/b.md");
  const log = seed("errors.log", old);
  const current = seed("current/repo", old);
  const dry = f.cli(["prune", "--dry-run"], { now });
  assert.equal(dry.code, 0);
  assert.equal(dry.stdout, "pruned: 3 file(s), 3 bytes freed (dry run); kept 1\n", "the plugin-kit contract line; a dry run counts the same");
  for (const still of [oldReceipt, oldStop, oldSession]) assert.equal(existsSync(still), true, still);
  const r = f.cli(["prune"], { now });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "pruned: 3 file(s), 3 bytes freed; kept 1\n");
  for (const gone of [oldReceipt, oldStop, oldSession]) assert.equal(existsSync(gone), false, gone);
  for (const kept of [fresh, log, current]) assert.equal(existsSync(kept), true, kept);
  assert.match(f.cli(["prune", "--days", "1"], { now }).stdout, /^pruned: 0 file\(s\), 0 bytes freed; kept 1$/m);
  assert.match(f.cli(["prune", "--days", "0"], { now: now + 1000 }).stdout, /^pruned: 1 file\(s\), 1 bytes freed; kept 0$/m);
  assert.equal(f.cli(["prune"], { env: { ...f.env, XDG_STATE_HOME: join(f.base, "nowhere") } }).code, 0);
  assert.equal(parseArgs(["prune", "--dry-run"]).dryRun, true);
});

test("prune: a file that cannot be removed is kept, named on stderr, and the exit code stays 0", { skip: process.getuid?.() === 0 ? "root ignores modes" : false }, (t) => {
  const f = fixture(t);
  const now = Date.now();
  const old = new Date(now - 40 * 86_400_000);
  const dir = join(f.sd, "receipts");
  mkdirSync(dir, { recursive: true });
  const stuck = join(dir, "stuck.md");
  writeFileSync(stuck, "xx");
  utimesSync(stuck, old, old);
  chmodSync(dir, 0o555);
  try {
    const r = f.cli(["prune"], { now });
    assert.equal(r.code, 0, "exit 0 whatever happened to the file");
    assert.equal(r.stdout, "pruned: 0 file(s), 0 bytes freed; kept 1\n");
    assert.match(r.stderr, new RegExp(`^pattern-check: could not remove:\\n  ${stuck.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
    assert.equal(existsSync(stuck), true);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("usage: no command, an unknown command, and open without a subject exit 2", (t) => {
  const f = fixture(t);
  assert.equal(f.cli([]).code, 2);
  assert.equal(f.cli(["frobnicate"]).code, 2);
  const r = f.cli(["open"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /open needs the thing/);
});

test("open records what is being built and names the record command; status shows it", (t) => {
  const f = fixture(t);
  const r = f.cli(["open", "a", "retry", "helper", "--session", SESSION]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /opened for session 0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10 \(--session\)/);
  assert.match(r.stdout, /^what: a retry helper$/m);
  assert.ok(r.stdout.includes(`record --session ${SESSION} < table.md`), r.stdout);
  const s = JSON.parse(readFileSync(paths.session(f.sd, SESSION), "utf8"));
  assert.equal(s.what, "a retry helper");
  assert.equal(s.repo, f.repo);
  const st = f.cli(["status", "--session", SESSION]);
  assert.match(st.stdout, /^what: a retry helper$/m);
  assert.match(st.stdout, /^files touched: 0 \(threshold 3\)$/m);
  assert.match(st.stdout, /^receipt: none$/m);
});

test("the session key comes from --session, then PATTERN_CHECK_SESSION, then the hook's pointer, then the cwd", (t) => {
  const f = fixture(t);
  assert.match(f.cli(["status"]).stdout, /^session: cwd-[0-9a-f]{16} \(this working directory/m);
  writeCurrent(f.sd, f.repo, "from-hook");
  assert.match(f.cli(["status"]).stdout, /^session: from-hook \(the session the hook last saw/m);
  assert.match(f.cli(["status"], { env: { ...f.env, PATTERN_CHECK_SESSION: "from-env" } }).stdout, /^session: from-env \(PATTERN_CHECK_SESSION\)/m);
  assert.match(f.cli(["status", "--session", "explicit"]).stdout, /^session: explicit \(--session\)/m);
  assert.equal(f.cli(["status", "--session", "../bad"]).code, 2);
});

test("record from stdin writes the repo receipt and the state copy, marks the session, and says the directory is untracked", (t) => {
  const f = fixture(t);
  f.cli(["open", "thing", "--session", SESSION]);
  const table = `| retry helper | src/net/retry.ts:12 | reuse | same backoff | ${DESIGN} | ${FAIL} |\n| webhook parser | (none: grep webhook in src/) | new | nothing parses inbound webhooks | one inbound module (fewer moving parts); costs: the signer moves | ${FAIL} |\n`;
  const r = f.cli(["record", "--session", SESSION], { stdin: table });
  assert.equal(r.code, 0, r.stderr);
  const receipt = join(f.repo, ".pattern-check", `${SESSION}.md`);
  assert.equal(existsSync(receipt), true);
  assert.equal(readFileSync(receipt, "utf8"), readFileSync(paths.receiptCopy(f.sd, SESSION), "utf8"));
  assert.match(readFileSync(receipt, "utf8"), /^what: thing$/m);
  assert.match(readFileSync(receipt, "utf8"), /\| retry helper \| src\/net\/retry.ts:12 \| reuse \| same backoff \| none: weighed a shared helper, one caller \| throws, caller logs to stderr \| rerun after fixing input \| yes: pure \| n\/a: no retries \| stderr line \|/);
  assert.match(readFileSync(receipt, "utf8"), /\| webhook parser \| .* \| new \| .* \| one inbound module \(fewer moving parts\); costs: the signer moves \| throws, /);
  assert.ok(readFileSync(receipt, "utf8").includes("| new piece | existing pattern (file:line) | reuse / replace / new | reason | better design | fails how | next step | restart-safe | bounded | evidence kept |"));
  assert.match(r.stdout, /2 rows: 1 reuse, 0 replace, 1 new/);
  assert.match(r.stdout, /\.pattern-check\/ is untracked; add "\.pattern-check\/" to \.gitignore or \.git\/info\/exclude/);
  assert.equal(JSON.parse(readFileSync(paths.session(f.sd, SESSION), "utf8")).receipt, receipt);
  assert.match(f.cli(["status", "--session", SESSION]).stdout, /^receipt: .*\.pattern-check\/0b0e6a1c.*\.md$/m);
});

test("record with --row and --no-new-pieces; the untracked note is dropped when the directory is excluded", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".git", "info", "exclude"), ".pattern-check/\n");
  const r = f.cli(["record", "--session", SESSION, "--row", `a | src/a.ts:1 | reuse | fine | ${DESIGN} | ${FAIL}`]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /untracked/);
  const n = f.cli(["record", "--session", "other", "--no-new-pieces", "two copy edits"]);
  assert.equal(n.code, 0, n.stderr);
  assert.match(readFileSync(join(f.repo, ".pattern-check", "other.md"), "utf8"), /^No new pieces: two copy edits$/m);
});

test("record with an invalid table exits 1 and writes nothing", (t) => {
  const f = fixture(t);
  for (const [args, stdin, msg] of [
    [[], "", /the receipt is empty/],
    [[], `| a | b | maybe | c | ${DESIGN} | ${FAIL} |`, /decision must be one of/],
    [["--row", `a | | new | | ${DESIGN} | ${FAIL}`], null, /needs a reason/],
    [["--no-new-pieces", " "], null, /needs a reason/],
    // the better design cell
    [[], `| a | src/a.ts:1 | reuse | ok | ${FAIL} |`, /row "a" has no "better design" cell; every piece needs it after the reason, before fails how/],
    [["--row", `a | src/a.ts:1 | reuse | ok |  | ${FAIL}`], null, /row "a": "better design" is empty/],
    [["--row", `a | src/a.ts:1 | reuse | ok | TBD | ${FAIL}`], null, /row "a": "better design" is a placeholder \(TBD\)/],
    [["--row", `a | src/a.ts:1 | reuse | ok | n/a | ${FAIL}`], null, /row "a": "better design" is a placeholder \(n\/a\)/],
    [["--row", `a | src/a.ts:1 | reuse | ok | none | ${FAIL}`], null, /row "a": "better design" says none without what was weighed \(write "none: <what was weighed>"/],
    [["--row", `a | src/a.ts:1 | reuse | ok | none: TBD | ${FAIL}`], null, /row "a": "better design" says none without what was weighed/],
    [["--row", `a | src/a.ts:1 | reuse | ok | n/a: TBD | ${FAIL}`], null, /row "a": "better design" is a placeholder \(n\/a: TBD\)/],
    // the fail columns
    [[], "| a | src/a.ts:1 | reuse | ok |", /row "a" has no fail columns.*better design \| fails how \| next step \| restart-safe \| bounded \| evidence kept/],
    [["--row", `a | src/a.ts:1 | reuse | ok | ${DESIGN} |  | rerun | yes: pure | n/a: none | log`], null, /row "a": "fails how" is empty/],
    [["--row", `a | src/a.ts:1 | reuse | ok | ${DESIGN} | throws | rerun | yes: pure | n/a | log`], null, /row "a": "bounded" is n\/a without a reason/],
    [["--row", `a | src/a.ts:1 | reuse | ok | ${DESIGN} | throws | rerun | maybe | n/a: x | log`], null, /"restart-safe" must start with yes or no/],
    [["--row", `a | src/a.ts:1 | reuse | ok | ${DESIGN} | throws | rerun | yes: pure | n/a: x | TBD`], null, /"evidence kept" is a placeholder/],
  ]) {
    const r = f.cli(["record", "--session", SESSION, ...args], { stdin });
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.match(r.stderr, msg);
    assert.match(r.stderr, /^pattern-check: receipt not written: /);
  }
  assert.equal(existsSync(join(f.repo, ".pattern-check")), false);
  assert.equal(existsSync(paths.receiptCopy(f.sd, SESSION)), false);
});

test("an old four-column (0.2) or nine-column (0.3) receipt already on disk still counts: status finds it through receiptExists, the check both hooks use", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, ".pattern-check"), { recursive: true });
  writeFileSync(join(f.repo, ".pattern-check", `${SESSION}.md`), "# pattern-check receipt\n\nsession: x\n\n| new piece | existing pattern (file:line) | reuse / replace / new | reason |\n|---|---|---|---|\n| a | b:1 | reuse | c |\n");
  assert.match(f.cli(["status", "--session", SESSION]).stdout, /^receipt: .*\.pattern-check\/0b0e6a1c.*\.md$/m);
  writeFileSync(join(f.repo, ".pattern-check", "k3.md"), `# pattern-check receipt\n\nsession: k3\n\n| new piece | existing pattern (file:line) | reuse / replace / new | reason | fails how | next step | restart-safe | bounded | evidence kept |\n|---|---|---|---|---|---|---|---|---|\n| a | b:1 | reuse | c | ${FAIL} |\n`);
  assert.match(f.cli(["status", "--session", "k3"]).stdout, /^receipt: .*\.pattern-check\/k3\.md$/m);
});

test("spawned: record reads stdin only when no --row or --no-new-pieces is given", (t) => {
  const f = fixture(t);
  const viaStdin = f.spawn(["record", "--session", SESSION], `| a | src/a.ts:1 | reuse | ok | ${DESIGN} | ${FAIL} |\n`);
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  const viaFlag = f.spawn(["record", "--session", "k2", "--no-new-pieces", "x"], "| this | stdin | is | ignored |");
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.match(readFileSync(join(f.repo, ".pattern-check", "k2.md"), "utf8"), /No new pieces: x/);
  assert.equal(f.spawn(["status"]).status, 0);
  assert.equal(f.spawn([]).status, 2);
});
