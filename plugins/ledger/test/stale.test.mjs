import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, apply, openWorkload } from "./helpers.mjs";
import { days } from "../lib/time.mjs";

const box = sandbox();

test("§7 row 10: stale [N] lists open or parked workloads untouched for N days with the clearing lines; closed ones never", () => {
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  const old = openWorkload(box, "old open", { now: t0 });
  const parked = openWorkload(box, "old parked", { now: t0 });
  apply(box, [`park ${parked} later`], { now: t0 });
  const closed = openWorkload(box, "old closed", { now: t0 });
  apply(box, [`close ${closed} done`], { now: t0 });
  const fresh = openWorkload(box, "fresh", { now: t0 + days(10) });
  const r = apply(box, ["stale"], { now: t0 + days(10) }).results[0];
  assert.equal(r.status, "ok");
  const lines = r.message.split("\n");
  assert.equal(lines.length, 2, r.message);
  assert.ok(lines[0].startsWith(`${old} old open · open · last seen 10d ago · clear with: close ${old} <reason>  |  park ${old} <reason>`), lines[0]);
  assert.ok(lines[1].startsWith(`${parked} old parked · parked`), lines[1]);
  assert.ok(!r.message.includes(closed));
  assert.ok(!r.message.includes(fresh));
  const strict = apply(box, ["stale 30"], { now: t0 + days(10) }).results[0];
  assert.equal(strict.message, "no open or parked workloads untouched for 30 days");
});

test("config stale.days is the default N", () => {
  const b = sandbox();
  b.writeConfig({ stale: { days: 1 } });
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  openWorkload(b, "two days", { now: t0 });
  const r = apply(b, ["stale"], { now: t0 + days(2) }).results[0];
  assert.match(r.message, /two days · open · last seen 2d ago/);
});

test("answering, asking, and deciding touch last_seen_at", () => {
  const b = sandbox();
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  const wl = openWorkload(b, "touched", { now: t0 });
  apply(b, [{ tokens: ["decide", "x"], text: "" }], { now: t0 + days(9) });
  const r = apply(b, ["stale 7"], { now: t0 + days(10) }).results[0];
  assert.equal(r.message, "no open or parked workloads untouched for 7 days", r.message);
  assert.ok(wl);
});
