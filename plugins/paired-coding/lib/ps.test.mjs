// The parser of `ps -A -o pid=,pgid=,stat=` output that reapGroups relies on, judged only against
// captured output (lib/fixtures/), never hand-written samples. The fixtures come from a one-off
// capture run outside `node --test`: capture-ps-fixture.mjs, kept with the testbar notes in
// ~/agent-scratch/jo-wolff-plugins/paired-coding/. Where ps could not run, the capture saved
// ps.unavailable.txt instead, and the unavailable path is tested from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { psMembers, psProblem } from "./host-io.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const captured = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((n) => /^ps-pid-pgid-stat\.\w+\.txt$/.test(n)) : [];
const unavailable = join(FIXTURES, "ps.unavailable.txt");

test("ps that cannot run (captured spawnSync result) is a named fault, not an empty process list", { skip: !existsSync(unavailable) && "no ps.unavailable.txt captured" }, () => {
  const res = JSON.parse(readFileSync(unavailable, "utf8").split("\n")[1]);
  assert.equal(psProblem({ ...res, error: res.error ? Object.assign(new Error(res.error.message), { code: res.error.code }) : undefined }), `ps failed: ${res.error.code}`);
});

test("psProblem passes a clean exit and names a non-zero one by its stderr or status", () => {
  assert.equal(psProblem({ status: 0, stdout: "", stderr: "" }), null);
  assert.equal(psProblem({ status: 1, stderr: "ps: illegal option\n" }), "ps failed: ps: illegal option");
  assert.equal(psProblem({ status: 2, stderr: "" }), "ps failed: exit 2");
});

for (const name of captured) {
  test(`psMembers on captured ${name}: every live member of a group, zombies left out`, () => {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    const meta = JSON.parse(readFileSync(join(FIXTURES, name.replace(/\.txt$/, ".json")), "utf8"));
    const rows = text.split("\n").filter((l) => l.trim()).map((l) => l.trim().split(/\s+/));
    const zombieGroup = meta.zombieGroup;
    const inGroup = rows.filter(([, g]) => Number(g) === zombieGroup);
    assert.ok(inGroup.some(([, , s]) => s.startsWith("Z")), "the capture holds the zombie it made");
    const live = psMembers(text, [zombieGroup]);
    assert.deepEqual(live, inGroup.filter(([, , s]) => !s.startsWith("Z")).map(([p, g]) => ({ pid: Number(p), pgid: Number(g) })));
    assert.deepEqual(psMembers(text, []), []);
  });
}

test("captured ps output is present for at least one platform", { skip: captured.length === 0 && "ps could not run where the fixtures were captured; see ps.unavailable.txt and run capture-ps-fixture.mjs outside the sandbox" }, () => {
  assert.ok(captured.length > 0);
});
