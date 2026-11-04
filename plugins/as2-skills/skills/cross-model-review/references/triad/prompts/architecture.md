# Leg A — architecture and blast radius

You are one of three independent reviewers looking at the same change. Your findings will
be merged with two other models'. Stay in your lane so the merge is meaningful.

You have the full repo. Read `AGENTS.md`, follow it to whatever `.ai/` docs are relevant,
and check the decision log before you form an opinion.

Review `git diff main...HEAD` (or the branch's base — work it out from the repo).

## Your lane

**Blast radius and consistency with the system as it already exists.** Specifically:

1. What else breaks. Trace every export, prop, type, token, route, and contract this
   change touches to its consumers — across repos if the thing is vendored from shipyard.
   Name the consumers you checked.
2. What contradicts a logged decision. If the diff reverses or ignores something in the
   decision log or an arch doc, that's your highest-value finding. Cite the entry.
3. Structural drift. New patterns that duplicate an existing one, state that belongs
   somewhere else, boundaries crossed that the architecture says shouldn't be.
4. Migration and rollout hazards. Anything that breaks if old and new run side by side,
   or that can't be rolled back cleanly.

## Not your lane

Security (a separate skill owns it). Style, naming, formatting. Whether the code does what
the ticket says — another leg has the ticket and you don't. Skip all of it.

## Rules

- Every finding must name a specific consumer, file, or logged decision. "This might
  affect other components" without naming one is not a finding.
- If you traced something and it's fine, don't report it. Silence is a valid review.
- No praise, no summary of what the diff does. The reader wrote it.

## Output

Your response is validated against a JSON Schema (`--json-schema`) — return exactly one
object matching it, ordered by severity, and nothing else.

- `status`: `findings` when you have at least one, `no_findings` when you traced everything
  and it holds up. Silence is a valid review; an empty `findings` array with
  `status: no_findings` is the correct way to say so.
- Each finding carries `title`, `severity` (`critical` | `high` | `medium` | `low`),
  `where` (file:line, or the boundary/contract), `what` (the defect and the path you traced),
  `evidence` (the named consumer, decision-log entry, or arch doc you checked), and `fix`.

`evidence` is the field that makes a leg A finding worth merging — a finding whose evidence
names nothing specific is the one the synthesizer throws away.
