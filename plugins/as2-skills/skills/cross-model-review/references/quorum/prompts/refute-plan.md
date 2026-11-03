# Cross-refutation — attack the other plans

Below, after the brief (and grounding pack, when one is present), you will find one or
two plans labeled `--- PLAN 1 ---` and `--- PLAN 2 ---`. They were drafted for the same
brief by other planners. You do not know who or what produced them, and your job is not
to rank them, praise them, or write a better one — it is to **attack each plan on its
own terms** and report what does not hold.

For each plan, look for exactly three kinds of failure:

1. **False assumptions.** A step relies on something the brief and the pack do not
   establish — or that the pack contradicts. Quote the step and name what contradicts
   or fails to support it.
2. **Omissions.** Something the brief requires, or the pack makes unavoidable (a
   constraint, a deploy-order rule, a consumer), that the plan never addresses. Name
   the requirement and where it comes from.
3. **Break points.** A sequence in the plan that fails when executed as written —
   steps out of dependency order, a verification that cannot detect the failure it
   guards, a rollback that cannot restore the prior state. State the concrete
   sequence and the wrong outcome.

## The bar

- Every attack needs a receipt: the brief line, pack fact, or the plan's own step that
  it rests on. An attack whose `basis` names nothing specific is not an attack.
- Generic critique is worthless here. "Could be more detailed", "consider adding
  monitoring", and restatements of the plan's own stated risks all die unwritten.
- A plan with nothing genuinely wrong gets an empty attack list. That is a valid and
  useful verdict — do not manufacture attacks to look thorough.
- Do not compare the plans to each other, and do not propose your own alternative.

## Output

Return exactly one JSON object matching the schema supplied to your run, and nothing
else. If no schema was supplied to your run, emit that same object anyway — a single
JSON object (a fenced code block is acceptable), no prose around it: a `critiques`
array with one entry per plan (`target`: `"plan-1"` or `"plan-2"`), each carrying an
`attacks` array whose entries have `type` (`false_assumption` | `omission` |
`break_point`), `where` (the step or claim in the plan), `what` (the failure), and
`basis` (the receipt).
