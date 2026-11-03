import test from "node:test";
import assert from "node:assert/strict";
import { renderHelp } from "../lib/commands.mjs";
import { VERBS, VERB_SET } from "../lib/parse.mjs";
import { sandbox, cli } from "./helpers.mjs";

const box = sandbox();

test("§7 row 9 (#179): help prints every verb the parser knows, with who says it", () => {
  const text = renderHelp();
  for (const v of VERB_SET) assert.ok(text.includes(`  ${v}`), v);
  for (const v of VERBS) assert.ok(text.includes(`[${v.who}] ${v.help}`), v.verb);
  assert.match(text, /ids: q- question, an- answer, nt- note/);
  assert.match(text, /batch: with no verb and stdin piped, one command per line/);
});

test("the CLI with a TTY and no argument prints help; `ledger help` prints the same", () => {
  const r = cli(box, ["help"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), renderHelp());
});
