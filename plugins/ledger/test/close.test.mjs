import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, apply, openWorkload, askQuestion, openDb, count, row } from "./helpers.mjs";

const box = sandbox();

test("§7 row 10: close needs only a reason; open questions on it are withdrawn in the same transaction and named", () => {
  const wl = openWorkload(box, "row 10");
  const q = askQuestion(box, { name: "left open", options: "a,b" });
  const noReason = apply(box, [`close ${wl}`]).results[0];
  assert.equal(noReason.status, "refused");
  assert.match(noReason.message, /needs a reason/);
  const r = apply(box, [`close ${wl} tests green`]).results[0];
  assert.equal(r.status, "ok", r.message);
  assert.match(r.message, new RegExp(`${wl} closed \\(tests green\\) · de-[a-z0-9]+; withdrew ${q}`));
  const db = openDb(box);
  const w = db.prepare("SELECT status, status_reason, closed_at FROM workloads WHERE id = ?").get(wl);
  assert.equal(w.status, "closed");
  assert.equal(w.status_reason, "tests green");
  assert.ok(w.closed_at);
  assert.equal(db.prepare("SELECT state FROM questions WHERE id = ?").get(q).state, "withdrawn");
  assert.equal(count(db, "decisions", "workload_id = ? AND kind = 'close'", wl), 1);
  db.close();
  const again = apply(box, [`close ${wl} again`]).results[0];
  assert.equal(again.status, "ok");
  assert.match(again.message, /already closed/);
});

test("step 4: open the same title twice in one cwd → one row, second returns the id", () => {
  const a = apply(box, [{ tokens: ["open", "same title"], text: "" }]).results[0];
  const b = apply(box, [{ tokens: ["open", "same title"], text: "" }]).results[0];
  assert.equal(a.id, b.id);
  assert.match(b.message, /already open with that title/);
  const db = openDb(box);
  assert.equal(count(db, "workloads", "title = 'same title'"), 1);
  db.close();
});

test("step 4: halt then open wl-… → status open with a reopen decision; the gate names the halt meanwhile", () => {
  const wl = openWorkload(box, "halt me");
  const h = apply(box, [`halt ${wl}`]).results[0];
  assert.equal(h.status, "ok", h.message);
  const db = openDb(box);
  assert.equal(db.prepare("SELECT status FROM workloads WHERE id = ?").get(wl).status, "halted");
  const again = apply(box, [`halt ${wl}`]).results[0];
  assert.equal(again.status, "refused");
  const re = apply(box, [`open ${wl}`]).results[0];
  assert.equal(re.status, "ok", re.message);
  assert.equal(db.prepare("SELECT status, status_reason FROM workloads WHERE id = ?").get(wl).status, "open");
  assert.equal(count(db, "decisions", "workload_id = ? AND kind = 'reopen'", wl), 1);
  assert.match(apply(box, [`open ${wl}`]).results[0].message, /already open/);
  db.close();
});

test("park needs a reason, parks, and open wl-… resumes; a closed workload cannot be reopened", () => {
  const wl = openWorkload(box, "park me");
  assert.equal(apply(box, [`park ${wl}`]).results[0].status, "refused");
  const p = apply(box, [`park ${wl} waiting on design`]).results[0];
  assert.equal(p.status, "ok", p.message);
  assert.match(p.message, new RegExp(`parked \\(waiting on design\\) · de-[a-z0-9]+; resume with open ${wl}`));
  assert.match(apply(box, [`park ${wl} again`]).results[0].message, /already parked/);
  assert.equal(apply(box, [`open ${wl}`]).results[0].status, "ok");
  apply(box, [`close ${wl} done`]);
  const r = apply(box, [`open ${wl}`]).results[0];
  assert.equal(r.status, "refused");
  assert.match(r.message, /is closed \(done\)/);
});

test("withdraw wl-… closes with reason `withdrawn`, refused while questions are open", () => {
  const wl = openWorkload(box, "withdraw me");
  const q = askQuestion(box, { name: "blocker", options: "a,b" });
  const r = apply(box, [`withdraw ${wl}`]).results[0];
  assert.equal(r.status, "refused");
  assert.match(r.message, new RegExp(`has open questions: ${q}`));
  apply(box, [`withdraw ${q}`]);
  const ok = apply(box, [`withdraw ${wl}`]).results[0];
  assert.equal(ok.status, "ok", ok.message);
  const db = openDb(box);
  assert.equal(db.prepare("SELECT status_reason FROM workloads WHERE id = ?").get(wl).status_reason, "withdrawn");
  db.close();
});

test("step 4: extend wl-… with no ceiling → refused with the ceiling hint; after ceiling 50 6h → 100/12", () => {
  const wl = openWorkload(box, "ceilings");
  const none = apply(box, [`extend ${wl}`]).results[0];
  assert.equal(none.status, "refused");
  assert.match(none.message, new RegExp(`no ceiling on ${wl}; set one with ceiling <usd> \\[<hours>\\] ${wl}`));
  const c = apply(box, [`ceiling 50 6h ${wl}`]).results[0];
  assert.equal(c.status, "ok", c.message);
  assert.match(c.message, /ceiling \$50\/6h on wl-.* \(extend adds \$50\/6h each time\)/);
  const e = apply(box, [`extend ${wl}`]).results[0];
  assert.equal(e.status, "ok", e.message);
  assert.match(e.message, /ceiling now \$100\/12h/);
  const db = openDb(box);
  const latest = row(db, "SELECT usd, hours, block_usd, block_hours FROM ceilings WHERE workload_id = ? ORDER BY set_at DESC, id DESC LIMIT 1", wl);
  assert.deepEqual(latest, { usd: 100, hours: 12, block_usd: 50, block_hours: 6 });
  assert.equal(count(db, "decisions", "workload_id = ? AND kind IN ('ceiling','extend')", wl), 2);
  db.close();
  // A later explicit ceiling keeps the first block size; given without hours, it has no hours cap to extend.
  apply(box, [`ceiling 500 ${wl}`]);
  assert.match(apply(box, [`extend ${wl}`]).results[0].message, /ceiling now \$550 on/);
});

test("extend q-… moves the deadline by its original span; refused without a deadline", () => {
  openWorkload(box, "deadlines");
  const plain = askQuestion(box, { body: "Plain?", name: "plain", options: "a,b" });
  const r = apply(box, [`extend ${plain}`]).results[0];
  assert.equal(r.status, "refused");
  assert.match(r.message, /no deadline to extend/);
  const now = Date.parse("2026-11-03T10:00:00.000Z");
  const q = askQuestion(box, { body: "Timed?", name: "timed", options: "a,b", extra: ["--deadline", "2h"], now });
  const e = apply(box, [`extend ${q}`], { now: now + 60_000 }).results[0];
  assert.equal(e.status, "ok", e.message);
  const db = openDb(box);
  assert.equal(db.prepare("SELECT deadline FROM questions WHERE id = ?").get(q).deadline, "2026-11-03T14:00:00.000Z");
  db.close();
});

test("decide records on the open workload (or --wl) and is refused with no workload", () => {
  const other = sandbox();
  const none = apply(other, [{ tokens: ["decide", "use sqlite"], text: "" }]).results[0];
  assert.equal(none.status, "refused");
  const wl = openWorkload(other, "decisions");
  const d = apply(other, [{ tokens: ["decide", "use sqlite"], text: "" }]).results[0];
  assert.equal(d.status, "ok", d.message);
  assert.match(d.id, /^de-/);
  const db = openDb(other);
  assert.deepEqual(row(db, "SELECT kind, body, made_by FROM decisions WHERE id = ?", d.id), { kind: "decide", body: "use sqlite", made_by: "agent" });
  db.close();
  assert.equal(apply(other, [{ tokens: ["decide", "x", "--wl", "wl-nope"], text: "" }]).results[0].status, "refused");
  assert.equal(apply(other, [{ tokens: ["decide", "x", "--wl", wl], text: "" }]).results[0].status, "ok");
});

test("open validates --stakes", () => {
  const r = apply(box, [{ tokens: ["open", "x", "--stakes", "huge"], text: "" }]).results[0];
  assert.equal(r.status, "refused");
  assert.match(r.message, /--stakes must be one of throwaway, normal, production/);
});
