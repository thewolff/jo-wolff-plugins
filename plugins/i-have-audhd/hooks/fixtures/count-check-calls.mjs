// count-check-calls.mjs — loaded with `node --import` by hooks/i-have-audhd-stop.test.mjs to
// count how often the Stop hook calls each rule predicate, so "a disabled rule's check does not
// run" is asserted by execution, not by empty output (a discarded finding is silent too).
//
// A synchronous module hook rewrites every checks/*.mjs and triggers/*.mjs source in memory: each
// exported predicate (check*, badNewsGate, findTrailingBatchSection, conclusionFirstApplicable,
// lastIncompleteTodos) is reassigned to a wrapper that appends its name to the file named by
// AUDHD_CHECK_COUNT_FILE, one line per call. Reassigning the module's own binding is what the
// hook's import sees, so the count is of the exported symbol, not a copy. No file on disk changes.

import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const OUT = process.env.AUDHD_CHECK_COUNT_FILE;
const PREDICATE =
  /^export function (check\w+|badNewsGate|findTrailingBatchSection|conclusionFirstApplicable|lastIncompleteTodos)\b/gm;

globalThis.__audhdCountCheck = (name) => appendFileSync(OUT, `${name}\n`);

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!OUT || !/\/(checks|triggers)\/[^/]+\.mjs$/.test(url) || url.endsWith(".test.mjs")) return result;
    const source = String(result.source);
    const names = [...source.matchAll(PREDICATE)].map((m) => m[1]);
    if (!names.length) return result;
    const wrappers = names
      .map(
        (n) =>
          `{ const real = ${n}; ${n} = function (...args) { globalThis.__audhdCountCheck(${JSON.stringify(n)}); return real.apply(this, args); }; }`,
      )
      .join("\n");
    return { ...result, source: `${source}\n${wrappers}\n` };
  },
});
