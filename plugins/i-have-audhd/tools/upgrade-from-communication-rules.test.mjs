// upgrade-from-communication-rules.test.mjs — node --test
//
// The tool runs as a SUBPROCESS against an isolated $HOME: its contract is about files it may
// and may not touch, and about what it must never print. The sentinel strings stand in for a
// real reader's profile; no assertion may find one in the tool's output.
//
// Run: node --test 'plugins/i-have-audhd/tools/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./upgrade-from-communication-rules.mjs", import.meta.url));

const SENTINELS = ["PRIVATE-READER-SENTINEL", "PRIVATE-TRAIT-SENTINEL", "PRIVATE-JUDGE-SENTINEL", "PRIVATE-ARM-SENTINEL"];

const PROFILE = JSON.stringify(
  {
    reader: "PRIVATE-READER-SENTINEL",
    traits: ["PRIVATE-TRAIT-SENTINEL"],
    enforcement: {
      judgeCommand: "PRIVATE-JUDGE-SENTINEL -",
      rules: { "name-the-artifact": "block" },
      armOmp: "PRIVATE-ARM-SENTINEL", // invalid: the loader ignores it and logs it
    },
  },
  null,
  2,
);

function mkhome({ profile = PROFILE, killSwitch = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "audhd-upgrade-home-"));
  const claude = join(home, ".claude");
  mkdirSync(join(claude, ".communication-rules-state"), { recursive: true });
  writeFileSync(join(claude, ".communication-rules-state", "warnings.log"), "old log line\n");
  writeFileSync(join(claude, ".communication-rules-state", "resume-s1"), "");
  if (profile !== null) {
    writeFileSync(join(claude, "communication-rules.json"), profile);
    chmodSync(join(claude, "communication-rules.json"), 0o644);
  }
  if (killSwitch) writeFileSync(join(claude, ".communication-rules-off"), "");
  return { home, claude };
}

function run(home, args = [], extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^(COMMUNICATION_RULES_|I_HAVE_AUDHD_)/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 60_000 });
  for (const s of SENTINELS) {
    assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), `output leaked ${s}`);
  }
  return r;
}

const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const noStaging = (dir) => assert.deepEqual(readdirSync(dir).filter((n) => /\.upgrade-[0-9a-f]+\.tmp$/.test(n)), []);
const RECEIPTS = [".i-have-audhd.json.upgrade-receipt", ".i-have-audhd-off.upgrade-receipt"];

test("preview writes nothing and reports effective modes without profile contents", () => {
  const { home, claude } = mkhome();
  const before = readdirSync(claude).sort();
  const r = run(home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readdirSync(claude).sort(), before);
  assert.match(r.stdout, /name-the-artifact=block/);
  assert.match(r.stdout, /invalid enforcement values the loader ignores: 1/);
});

test("apply carries the kill switch and profile byte-for-byte at 0600 and leaves the originals and old state", () => {
  const { home, claude } = mkhome();
  const r = run(home, ["--apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(claude, "i-have-audhd.json"), "utf8"), PROFILE);
  assert.equal(mode(join(claude, "i-have-audhd.json")), "600");
  assert.ok(existsSync(join(claude, ".i-have-audhd-off")));
  assert.equal(readFileSync(join(claude, "communication-rules.json"), "utf8"), PROFILE);
  assert.equal(mode(join(claude, "communication-rules.json")), "644");
  assert.ok(existsSync(join(claude, ".communication-rules-off")));
  assert.equal(readFileSync(join(claude, ".communication-rules-state", "warnings.log"), "utf8"), "old log line\n");
  assert.ok(!existsSync(join(claude, ".i-have-audhd-state")), "the loader check must not log into the real state dir");
  noStaging(claude);
  assert.match(r.stdout, /verified on the copy before it was placed/);
});

test("apply never overwrites an existing different target", () => {
  const { home, claude } = mkhome();
  writeFileSync(join(claude, "i-have-audhd.json"), "{}");
  const r = run(home, ["--apply"]);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(claude, "i-have-audhd.json"), "utf8"), "{}");
  assert.ok(existsSync(join(claude, ".i-have-audhd-off")), "the kill switch is carried independently");
  noStaging(claude);
});

test("an unparseable profile is refused without echoing it", () => {
  const { home, claude } = mkhome({ profile: '{"reader": "PRIVATE-READER-SENTINEL",' });
  const r = run(home, ["--apply"]);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(claude, "i-have-audhd.json")));
  assert.ok(!existsSync(join(claude, ".i-have-audhd-state")));
  noStaging(claude);
});

test("undo removes unedited copies only and never the originals", () => {
  const { home, claude } = mkhome();
  assert.equal(run(home, ["--apply"]).status, 0);
  writeFileSync(join(claude, "i-have-audhd.json"), PROFILE + "\n"); // the operator edited it
  const r = run(home, ["--undo"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(join(claude, ".i-have-audhd-off")));
  assert.ok(existsSync(join(claude, "i-have-audhd.json")));
  assert.ok(existsSync(join(claude, "communication-rules.json")));
  assert.ok(existsSync(join(claude, ".communication-rules-off")));
});

test("a pre-existing byte-identical profile and kill switch survive apply, a rerun, and undo", () => {
  const { home, claude } = mkhome();
  const profile = join(claude, "i-have-audhd.json");
  const off = join(claude, ".i-have-audhd-off");
  writeFileSync(profile, PROFILE, { mode: 0o600 });
  writeFileSync(off, "", { mode: 0o600 });
  chmodSync(profile, 0o600);
  chmodSync(off, 0o600);
  for (let i = 0; i < 2; i++) {
    const a = run(home, ["--apply"]);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /already holds the same bytes; nothing to do \(no receipt written/);
    for (const r of RECEIPTS) assert.ok(!existsSync(join(claude, r)), `${r} claims a file --apply did not create`);
    const u = run(home, ["--undo"]);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.equal(readFileSync(profile, "utf8"), PROFILE);
    assert.ok(existsSync(off));
  }
});

test("undo removes its own unchanged copies and their 0600 receipts, which hold no profile contents", () => {
  const { home, claude } = mkhome();
  assert.equal(run(home, ["--apply"]).status, 0);
  assert.equal(run(home, ["--apply"]).status, 0, "a rerun leaves the receipts alone");
  for (const r of RECEIPTS) {
    assert.equal(mode(join(claude, r)), "600");
    const text = readFileSync(join(claude, r), "utf8");
    for (const s of SENTINELS) assert.ok(!text.includes(s), `receipt ${r} holds ${s}`);
  }
  const r = run(home, ["--undo"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!existsSync(join(claude, "i-have-audhd.json")));
  assert.ok(!existsSync(join(claude, ".i-have-audhd-off")));
  for (const name of RECEIPTS) assert.ok(!existsSync(join(claude, name)));
  assert.equal(readFileSync(join(claude, "communication-rules.json"), "utf8"), PROFILE);
  assert.ok(existsSync(join(claude, ".communication-rules-off")));
});

test("a copy the operator replaced with identical bytes is kept, even across an apply rerun", () => {
  const { home, claude } = mkhome();
  const profile = join(claude, "i-have-audhd.json");
  assert.equal(run(home, ["--apply"]).status, 0);
  unlinkSync(profile); // the operator replaces the copy with their own identical file
  writeFileSync(profile, PROFILE, { mode: 0o600 });
  chmodSync(profile, 0o600);
  const receipt = readFileSync(join(claude, RECEIPTS[0]), "utf8");
  assert.equal(run(home, ["--apply"]).status, 0);
  assert.equal(readFileSync(join(claude, RECEIPTS[0]), "utf8"), receipt, "the rerun must not re-claim the operator's file");
  const r = run(home, ["--undo"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /i-have-audhd\.json kept: edited or replaced/);
  assert.equal(readFileSync(profile, "utf8"), PROFILE);
  assert.ok(!existsSync(join(claude, ".i-have-audhd-off")), "the unchanged kill switch copy is still removed");
});

test("after undo, an operator's own identical copy is not claimed by an apply rerun", () => {
  const { home, claude } = mkhome({ killSwitch: false });
  const profile = join(claude, "i-have-audhd.json");
  assert.equal(run(home, ["--apply"]).status, 0);
  assert.equal(run(home, ["--undo"]).status, 0);
  assert.ok(!existsSync(profile));
  writeFileSync(profile, PROFILE, { mode: 0o600 });
  chmodSync(profile, 0o600);
  assert.equal(run(home, ["--apply"]).status, 0);
  assert.ok(!existsSync(join(claude, RECEIPTS[0])), "the rerun must not claim the operator's file");
  assert.equal(run(home, ["--undo"]).status, 0);
  assert.equal(readFileSync(profile, "utf8"), PROFILE);
});

test("a new profile name that resolves to the original is left alone by apply and undo", () => {
  const { home, claude } = mkhome({ killSwitch: false });
  const original = join(claude, "communication-rules.json");
  assert.equal(run(home, ["--apply"], { I_HAVE_AUDHD_PROFILE: original }).status, 0);
  assert.equal(run(home, ["--undo"], { I_HAVE_AUDHD_PROFILE: original }).status, 0);
  assert.equal(readFileSync(original, "utf8"), PROFILE);
  assert.ok(!existsSync(join(claude, "i-have-audhd.json")));
});

test("old environment variables are named with their replacement, never their values", () => {
  const { home } = mkhome({ profile: null, killSwitch: false });
  const r = run(home, [], { COMMUNICATION_RULES_INJECT: "off-PRIVATE-VALUE" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /COMMUNICATION_RULES_INJECT is set \(value not shown\): set I_HAVE_AUDHD_INJECT/);
  assert.ok(!r.stdout.includes("off-PRIVATE-VALUE"));
});
