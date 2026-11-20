// review-claudex.test.mjs — a claudex-loop Codex inspection that APPROVED exactly the reviewed
// change stands in for the codex lab (0.4.10, lib/review/claudex.mjs). The snapshots are the real
// claudex-loop runner's (test/fixtures/claudex/snapshot.*.json, from capture-claudex-fixture.mjs
// over the repository in claudex-repo.mjs); result.revise.json is a real inspect result, trimmed
// and with its paths replaced. Every mismatch — another verdict, a material finding, one more
// commit, another base, another plan than the current receipt, an unusable file — runs codex.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, opendirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox, cli, openDb } from "./helpers.mjs";
import { buildRepo, commitAll } from "./claudex-repo.mjs";
import { MAX_ENTRIES, candidates, claudexDirs, findApproval, mismatch, readRecord, repoName, snapshotAt } from "../lib/review/claudex.mjs";
import { gitIn } from "./claudex-repo.mjs";

const SID = "s-claudex";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claudex");
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The fixture repository in the sandbox's work folder, its change committed on `feat`. */
function repo(variant = "staged", config = {}) {
  const b = sandbox();
  const base = buildRepo(b.work, b.env, variant);
  const snapshot = fixture(`snapshot.${variant}.json`);
  assert.equal(base, snapshot.base, "the fixture repository rebuilds to the captured base");
  const head = commitAll(b.work, b.env);
  b.writeConfig({ review: { mode: "gate", labs: ["codex"], ...config } });
  return { b, base, head, snapshot };
}
/** A real-shaped inspect result (from result.revise.json) turned into an approval of `snapshot` in `b.work`. */
function approved(b, snapshot, patch = {}) {
  const r = fixture("result.revise.json");
  return {
    ...r,
    repo: b.work,
    plan: join(b.work, ".pattern-check", "PLAN.md"),
    base: snapshot.base.slice(0, 8),
    snapshot,
    artifacts: join(b.root, "claudex-run"),
    ...patch,
    response: { ...r.response, verdict: "APPROVED", findings: [], ...(patch.response ?? {}) },
  };
}
function writeResult(dir, record) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "result.json");
  writeFileSync(path, typeof record === "string" ? record : JSON.stringify(record, null, 2));
  return path;
}
/** A codex stub that records being run (`<path>.ran`) and prints `reply`. */
function codex(b, reply = "PASS") {
  const path = join(b.root, "stub-codex");
  writeFileSync(path, `#!/bin/sh\ncat > /dev/null\necho ran > "${path}.ran"\ncat <<'EOF'\n${reply}\nEOF\n`);
  chmodSync(path, 0o755);
  return path;
}
const review = (b, args = []) => {
  const bin = codex(b);
  const r = cli(b, ["review", ...args], { env: { LEDGER_SESSION_ID: SID, LEDGER_REVIEW_BIN_CODEX: bin } });
  return { ...r, ran: existsSync(`${bin}.ran`) };
};
const codexRow = (b) => {
  const db = openDb(b);
  try {
    return { ...db.prepare("SELECT verdict, reason, model, findings_json FROM cc_reviews WHERE lab = 'codex' ORDER BY id DESC").get() };
  } finally {
    db.close();
  }
};

test("(b) an APPROVED inspection found under the default folder (~/agent-scratch/{repo}) records codex pass for HEAD without running codex", () => {
  const { b, snapshot } = repo("staged");
  writeResult(join(b.home, "agent-scratch", "work", "eng-inspect-r1", "claudex-abc"), approved(b, snapshot));
  const r = review(b);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.ran, false, "codex was not run");
  assert.match(r.out, /codex: pass .*claudex inspect APPROVED/, r.out);
  const row = codexRow(b);
  assert.equal(row.verdict, "pass");
  assert.match(row.reason, /^claudex inspect APPROVED, .*claudex-run, snapshot [0-9a-f]{8}$/);
});

test("(b) new files left untracked at the inspection still match once committed (--claudex <file>)", () => {
  const { b, snapshot } = repo("untracked", { claudexDirs: [] });
  const path = writeResult(join(b.root, "elsewhere"), approved(b, snapshot));
  const r = review(b, ["--claudex", path]);
  assert.equal(r.ran, false, r.out);
  assert.equal(codexRow(b).verdict, "pass");
});

test("(b) ledger's snapshot of HEAD equals the real runner's, file by file", () => {
  for (const variant of ["staged", "untracked"]) {
    const { b, base, head, snapshot } = repo(variant);
    const mine = snapshotAt(b.work, base, head);
    assert.equal(mine.files.size, snapshot.files.length);
    for (const f of snapshot.files) assert.equal(mine.files.get(f.path), `${f.kind}:${f.sha256}`, f.path);
    assert.ok(mine.diffs.includes(snapshot.diff_sha256), variant);
  }
});

test("(b) low findings in an approval become nits: pass with nits, still no codex run", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  const dir = join(b.root, "r");
  writeResult(dir, approved(b, snapshot, { response: { findings: [{ id: "L1", severity: "low", path: "a.txt", evidence: "naming", fix: "rename" }] } }));
  const r = review(b, ["--claudex", dir]);
  assert.equal(r.ran, false, r.out);
  assert.match(r.out, /codex: pass with nits .*: 0 blocking, 0 should, 1 nit · claudex inspect APPROVED, .*claudex-run, snapshot [0-9a-f]{8}/, r.out);
  const row = codexRow(b);
  assert.equal(row.verdict, "pass-with-nits");
  assert.deepEqual(JSON.parse(row.findings_json).map((i) => i.severity), ["nit"]);
});

test("(c) the real REVISE result does not count: codex runs", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  const real = fixture("result.revise.json");
  assert.equal(real.response.verdict, "REVISE");
  const dir = join(b.root, "r");
  writeResult(dir, { ...real, repo: b.work, snapshot });
  assert.equal(mismatch(readRecord(join(dir, "result.json")), { top: b.work, base: snapshot.base, receipt: {}, snapshotOf: () => null }), "verdict REVISE");
  assert.equal(review(b, ["--claudex", dir]).ran, true);
});

test("(c) one more commit after the inspection: the snapshot does not match HEAD and codex runs", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  writeFileSync(join(b.work, "a.txt"), "one\nTWO\nthree\nfour\n");
  commitAll(b.work, b.env, "after the inspection");
  const dir = join(b.root, "r");
  writeResult(dir, approved(b, snapshot));
  assert.equal(review(b, ["--claudex", dir]).ran, true);
});

test("(c) another base, a high finding, another repository, a non-codex provider: codex runs each time", () => {
  const cases = [
    (b, s) => approved(b, { ...s, base: "0".repeat(40) }),
    (b, s) => approved(b, s, { response: { findings: [{ id: "H1", severity: "high", path: "a.txt", evidence: "bug", fix: "fix" }] } }),
    (b, s) => approved(b, s, { repo: b.sibling }),
    (b, s) => approved(b, s, { provider: "claude" }),
    (b, s) => approved(b, s, { status: "failed" }),
  ];
  for (const make of cases) {
    const { b, snapshot } = repo("staged", { claudexDirs: [] });
    const dir = join(b.root, "r");
    writeResult(dir, make(b, snapshot));
    assert.equal(review(b, ["--claudex", dir]).ran, true, make.toString());
  }
});

test("(c2) the inspection is bound to the current receipt: its plan matches → no codex run; the receipt changes after → codex runs", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  mkdirSync(join(b.work, ".pattern-check"), { recursive: true });
  const receipt = join(b.work, ".pattern-check", "PLAN.md");
  writeFileSync(receipt, "# PLAN\n1. criterion\n");
  const dir = join(b.root, "r");
  writeResult(dir, approved(b, snapshot, { plan_sha256: sha256(readFileSync(receipt)) }));
  assert.equal(review(b, ["--claudex", dir]).ran, false, "plan is the current receipt");
  writeFileSync(receipt, "# PLAN\n1. criterion\n2. a new requirement\n");
  assert.equal(review(b, ["--claudex", dir, "--force-round"]).ran, true, "receipt changed after the approval");
});

test("(d) malformed JSON, a 2 MiB file and a missing folder: codex runs and the review exits 0", () => {
  const { b } = repo("staged", { claudexDirs: [] });
  const bad = writeResult(join(b.root, "bad"), "{ not json");
  const huge = writeResult(join(b.root, "huge"), JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }));
  const r = review(b, ["--claudex", bad, "--claudex", huge, "--claudex", join(b.root, "no-such-folder")]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.ran, true);
  assert.match(r.out, /codex: pass/);
  const log = readFileSync(b.errorsLog, "utf8");
  assert.match(log, /claudex result .*bad\/result\.json not usable/);
  assert.match(log, /over 1048576; skipped/);
  assert.match(log, /no-such-folder not readable/);
});

test("(d) a JSON array and a record with malformed findings: each logged once, codex runs; a REVISE stays silent", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  const arr = writeResult(join(b.root, "arr"), "[1, 2]");
  const bad = join(b.root, "bad");
  writeResult(bad, approved(b, snapshot, { response: { findings: [{ id: "X1", severity: "blocking", path: "a.txt", evidence: "e" }] } }));
  const revise = join(b.root, "revise");
  writeResult(revise, approved(b, snapshot, { response: { verdict: "REVISE", findings: [] } }));
  const r = review(b, ["--claudex", arr, "--claudex", bad, "--claudex", revise]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.ran, true);
  const log = readFileSync(b.errorsLog, "utf8");
  assert.match(log, /arr\/result\.json is not a JSON object; skipped/);
  assert.equal(log.match(/bad\/result\.json skipped: malformed findings/g)?.length, 1);
  assert.ok(!/revise\/result\.json/.test(log), "an ordinary non-match is not logged");
});

test("(d) an approval with no snapshot object: logged once as malformed, codex runs", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  const dir = join(b.root, "nosnap");
  writeResult(dir, approved(b, snapshot, { snapshot: null }));
  const r = review(b, ["--claudex", dir]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.ran, true);
  assert.equal(readFileSync(b.errorsLog, "utf8").match(/nosnap\/result\.json skipped: no snapshot object/g)?.length, 1);
});

test("(d) a missing default folder is silent; review.claudexDirs [] turns the search off", () => {
  const { b } = repo("staged");
  const r = review(b);
  assert.equal(r.ran, true);
  assert.ok(!existsSync(b.errorsLog) || !/claudex/.test(readFileSync(b.errorsLog, "utf8")));
  const off = repo("staged", { claudexDirs: [] });
  writeResult(join(off.b.home, "agent-scratch", "work", "x"), approved(off.b, off.snapshot));
  assert.equal(review(off.b).ran, true, "the default folder is not searched when the list is empty");
});

test("(c) a duplicated tracked entry standing in for an added file, with the fallback diff digest: no match, codex runs", () => {
  const { b, snapshot } = repo("untracked", { claudexDirs: [] });
  const a = snapshot.files.find((f) => f.path === "a.txt");
  const forged = { ...snapshot, files: snapshot.files.map((f) => (f.path === "src/new.mjs" ? a : f)) };
  assert.equal(forged.files.length, snapshot.files.length);
  const dir = join(b.root, "r");
  writeResult(dir, approved(b, forged));
  assert.equal(review(b, ["--claudex", dir]).ran, true);
});

test("(d) a matching approval whose low finding has a non-string path: skipped, codex runs, the review is not left unavailable", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  const dir = join(b.root, "r");
  writeResult(dir, approved(b, snapshot, { response: { findings: [{ id: "L1", severity: "low", path: { toString: null }, evidence: "x" }] } }));
  const r = review(b, ["--claudex", dir]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.ran, true);
  assert.equal(codexRow(b).verdict, "pass");
});

test("(c) a severity outside the runner's high/medium/low (blocking, HIGH): malformed, codex runs", () => {
  for (const severity of ["blocking", "HIGH"]) {
    const { b, snapshot } = repo("staged", { claudexDirs: [] });
    const dir = join(b.root, "r");
    writeResult(dir, approved(b, snapshot, { response: { findings: [{ id: "X1", severity, path: "a.txt", evidence: "bug", fix: "fix" }] } }));
    assert.equal(review(b, ["--claudex", dir]).ran, true, severity);
  }
});

test("(c2) the current receipt exists but cannot be read (the file, or its folder): no approval is reused, codex runs", () => {
  for (const target of ["file", "folder"]) {
    const { b, snapshot } = repo("staged", { claudexDirs: [] });
    const folder = join(b.work, ".pattern-check");
    mkdirSync(folder, { recursive: true });
    const receipt = join(folder, "PLAN.md");
    writeFileSync(receipt, "# PLAN\n");
    const dir = join(b.root, "r");
    writeResult(dir, approved(b, snapshot, { plan_sha256: "0".repeat(64) }));
    chmodSync(target === "file" ? receipt : folder, 0o000);
    try {
      assert.equal(review(b, ["--claudex", dir]).ran, true, target);
    } finally {
      chmodSync(target === "file" ? receipt : folder, target === "file" ? 0o644 : 0o755);
    }
  }
});

test("(c) an added executable file: no fallback digest, so an inspection of it as untracked (mode unchecked) cannot match", () => {
  const { b, base, head } = repo("untracked", { claudexDirs: [] });
  const plain = snapshotAt(b.work, base, head);
  assert.equal(plain.diffs.length, 2, "no executable added: the fallback stands");
  assert.notEqual(plain.diffs[1], plain.diffs[0], "the untracked variant adds files");
  const file = [...plain.files.keys()].find((p) => p.startsWith("src/"));
  chmodSync(join(b.work, file), 0o755);
  const head2 = commitAll(b.work, b.env, "make it executable");
  const exec = snapshotAt(b.work, base, head2);
  assert.deepEqual(exec.diffs.length, 1, "an added executable leaves only the full digest");
});

test("(d) a result whose repository path cannot be resolved: logged once, codex runs", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  const dir = join(b.root, "gone");
  writeResult(dir, approved(b, snapshot, { repo: join(b.root, "no-such-repo") }));
  const r = review(b, ["--claudex", dir]);
  assert.equal(r.ran, true, r.out);
  assert.equal(readFileSync(b.errorsLog, "utf8").match(/gone\/result\.json skipped: repository path not resolvable/g)?.length, 1);
});

test("(d) the receipt vanishes between newestReceipt and the hash read: logged once with its path, no approval", () => {
  const { b, base, head, snapshot } = repo("staged", { claudexDirs: [] });
  const dir = join(b.root, "race");
  writeResult(dir, approved(b, snapshot, { plan_sha256: "0".repeat(64) }));
  const gone = join(b.work, ".pattern-check", "PLAN.md");
  const found = findApproval({ top: b.work, base, head, receipt: { path: gone }, config: { review: { claudexDirs: [] } }, env: b.env, paths: [dir] });
  assert.equal(found, null);
  const log = readFileSync(b.errorsLog, "utf8");
  assert.equal(log.match(/race\/result\.json skipped: receipt not readable: .*PLAN\.md: ENOENT/g)?.length, 1, log);
});

test("(d) a completed codex inspection with no response object, or a verdict outside the runner's three: logged once each as malformed, codex runs", () => {
  const { b, snapshot } = repo("staged", { claudexDirs: [] });
  const none = approved(b, snapshot);
  delete none.response;
  writeResult(join(b.root, "noresp"), none);
  writeResult(join(b.root, "oddverdict"), approved(b, snapshot, { response: { verdict: "LGTM" } }));
  writeResult(join(b.root, "revise"), approved(b, snapshot, { response: { verdict: "REVISE" } }));
  const r = review(b, ["--claudex", join(b.root, "noresp"), "--claudex", join(b.root, "oddverdict"), "--claudex", join(b.root, "revise")]);
  assert.equal(r.ran, true, r.out);
  const log = readFileSync(b.errorsLog, "utf8");
  assert.equal(log.match(/noresp\/result\.json skipped: malformed response/g)?.length, 1, log);
  assert.equal(log.match(/oddverdict\/result\.json skipped: malformed response/g)?.length, 1, log);
  assert.doesNotMatch(log, /revise\/result\.json/, "an ordinary REVISE stays silent");
});

test("(d) the folder scan visits a bounded number of directory entries and logs once when the budget runs out", () => {
  const b = sandbox();
  const dir = join(b.root, "scratch");
  for (let i = 0; i < 30; i++) mkdirSync(join(dir, `d${String(i).padStart(2, "0")}`, "x"), { recursive: true });
  writeResult(join(dir, "zz"), "{}");
  const found = candidates([dir], { env: b.env, maxEntries: 10 });
  assert.deepEqual(found, [], "the scan stopped before reaching the result");
  const log = readFileSync(b.errorsLog, "utf8");
  assert.equal(log.match(/claudex results scan stopped after 10 directory entries/g)?.length, 1, log);
  assert.equal(candidates([dir], { env: b.env }).length, 1, "the default budget reaches it");
});

/** opendirSync wrapped to count every entry read and every handle opened and closed. */
function countingOpendir() {
  const c = { reads: 0, opened: 0, closed: 0 };
  c.opendir = (dir) => {
    const h = opendirSync(dir);
    c.opened++;
    return {
      readSync: () => {
        const e = h.readSync();
        if (e !== null) c.reads++;
        return e;
      },
      closeSync: () => {
        c.closed++;
        h.closeSync();
      },
    };
  };
  return c;
}

test("(d) a folder with more entries than the budget is read one entry at a time: at most budget+1 reads, every handle closed", () => {
  const b = sandbox();
  const dir = join(b.root, "huge");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 500; i++) writeFileSync(join(dir, `f${i}`), "");
  mkdirSync(join(dir, "sub"));
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, "sub", `g${i}`), "");
  const c = countingOpendir();
  assert.deepEqual(candidates([dir], { env: b.env, maxEntries: 10, opendir: c.opendir }), []);
  assert.ok(c.reads <= 11, `read ${c.reads} entries for a budget of 10`);
  assert.ok(c.opened >= 1);
  assert.equal(c.closed, c.opened, "every Dir handle is closed");
  assert.equal(readFileSync(b.errorsLog, "utf8").match(/claudex results scan stopped after 10 directory entries/g)?.length, 1);
});

test("(d) a Dir handle is closed when reading it throws, and the failure is logged, not thrown", () => {
  const b = sandbox();
  const dir = join(b.root, "flaky");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "f"), "");
  let closed = 0;
  const opendir = (d) => {
    const h = opendirSync(d);
    return {
      readSync: () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
      closeSync: () => {
        closed++;
        h.closeSync();
      },
    };
  };
  assert.deepEqual(candidates([dir], { env: b.env, opendir }), []);
  assert.equal(closed, 1);
  assert.match(readFileSync(b.errorsLog, "utf8"), /claudex results folder .*flaky not readable: EIO/);
});

test("(d) a real match is still found through the streamed scan, and its handles are closed", () => {
  const b = sandbox();
  const dir = join(b.root, "scratch");
  const want = writeResult(join(dir, "eng-inspect-r1", "claudex-abc"), "{}");
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `noise${i}`), "");
  const c = countingOpendir();
  assert.deepEqual(candidates([dir], { env: b.env, opendir: c.opendir }), [want]);
  assert.equal(c.closed, c.opened);
});

test("(d) a default folder over the default budget stops the scan, logs once, and codex still runs", () => {
  const { b } = repo("staged");
  const dir = join(b.home, "agent-scratch", "work");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i <= MAX_ENTRIES; i++) writeFileSync(join(dir, `f${i}`), "");
  const r = review(b);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.ran, true, "codex ran");
  const log = readFileSync(b.errorsLog, "utf8");
  assert.equal(log.match(new RegExp(`claudex results scan stopped after ${MAX_ENTRIES} directory entries`, "g"))?.length, 1, log);
});

test("(d) {repo} in a git worktree is the repository's name, not the worktree folder's", () => {
  const { b } = repo("staged", { claudexDirs: [] });
  const wt = join(b.root, "trusting-wt-folder");
  gitIn(b.work, b.env, "worktree", "add", "-q", "-b", "wt-branch", wt);
  assert.equal(repoName(b.work, b.env), "work");
  assert.equal(repoName(wt, b.env), "work");
  assert.deepEqual(claudexDirs({}, wt, b.home, b.env), [join(b.home, "agent-scratch", "work")]);
  assert.ok(!existsSync(b.errorsLog) || !/repository name/.test(readFileSync(b.errorsLog, "utf8")));
  const loose = join(b.root, "not-a-repo");
  mkdirSync(loose);
  assert.equal(repoName(loose, b.env), "not-a-repo", "outside git: the folder's name");
  assert.match(readFileSync(b.errorsLog, "utf8"), /repository name for .*not-a-repo not resolvable/);
});
