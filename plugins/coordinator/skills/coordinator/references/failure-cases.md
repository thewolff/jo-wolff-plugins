# Failure cases seen

Cases from the coordinating run that SKILL.md summarizes. Each names the slip and the habit that
closed it.

- **Approved work only logged.** The owner approved a piece of work and the coordinator
  logged it and moved on; the owner found it unstarted when they asked. An approval given inside
  an answer to something else was not recognised as one. The owed-list line in SKILL.md covers
  approvals in passing the same as direct ones.
- **A decision on an incomplete question.** The owner accepted something on a description
  that left out what the data actually held. Questions carry every fact the answer turns on.
- **A misread written down.** The coordinator wrote that a plan lacked a build order it
  had. Re-reading the source before writing a claim about it prevents this.
- **Review against a stale base.** A review pinned to `origin/main` while the branch sat
  behind it produced the same false findings round after round. Rebasing first, or leaving
  off the explicit base, avoided it.
- **Recommending a build before searching.** The coordinator recommended a new wrapper
  before checking for existing code that already did the job. A local search and a
  comparables check come before a recommendation to build.
- **Guessed timestamps.** Handoff blocks carried guessed times that ran out of order.
  Reading the clock fixed it.
- **Too many held items at once.** The owner was handed a long list of open items and
  objected. Two open decisions at a time, the rest held in the list with recommendations.
- **Handed scripts that misbehaved.** One was edited while the owner ran it, one printed a
  garbled undo line, two hung in a pager. Dry runs, `GH_PAGER=cat`, and leaving a script
  alone once handed over prevent these.
- **A gate walked around.** A peer session pushed branches past the review gate by
  changing directory before pushing. Running git with `-C <worktree>` keeps the gate
  looking at the right checkout.
- **Duplicate work.** Two sessions built the same feature because a handoff arrived late.
  Telling every session who owns which branch, at dispatch, prevents the overlap.
- **A filtered log hid the failure.** Filtering lines out of a log removed the line that
  mattered. Reading the unfiltered log first avoids this.
- **A hold logged as an answer.** Putting a question on hold was stored as its answer.
  Keeping "held" and "answered" separate in the decision log prevents the confusion later.
- **The wrong model, unannounced.** The session ran on a model other than the one the
  owner set for coordinators, and this came out only when the owner asked about usage.
  The model check in SKILL.md covers it.
- **A direct ask filed as low priority.** A request the owner made directly was treated as
  background work. A direct ask from the owner goes to the top of the next reply.
