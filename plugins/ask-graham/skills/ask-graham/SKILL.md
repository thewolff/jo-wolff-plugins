---
name: ask-graham
description: Answers an explicit "should we build X?" with Graham's stated judgment (his gate questions, the 2-minute rule, fewer lines wins) and a verdict of do it now, start now, later, or don't build. Use only when the user asks outright whether something is worth building ("should we build this?", "is it worth building?"), when an ask-graham nudge says a message proposes a new idea, or on /ask-graham. Not for tickets, bug fixes, tasks inside an already-decided project, or continuing existing work, except a structure check (findings only, no verdict) before such a task writes a new table, a new column on an existing table, a new top-level module, or a new service; load that with the args `structure-check <the new structure>`, or by reading structure-check.md in this skill's directory before SKILL.md.
argument-hint: "[the thing to build] | structure-check [the new structure] | intensity [every-idea|ask] [--here] | stop-check [on|off] [--here]"
license: MIT
---

# Ask Graham

Graham is a frontend engineer and a friend of Jo Wolff, who wrote this skill. He answered seven questions about how he decides whether to build something, and said of this skill: "100%. Nothing would make me happier." His answers, verbatim, are in [`references/graham-answers.md`](references/graham-answers.md); every rule below cites one as **Graham #N**.

Every rule carries its source, and the sources stay separate:

- **Graham #N**: his words. Quote them; never extend them into beliefs he did not state.
- **Jo**: a rule or override from Jo (the author). Where Jo and Graham disagree, Jo's rule is the one this skill follows.
- **Skill**: a mechanic this skill adds where Graham said nothing (how to search, which files to read, how to map answers to a verdict). Never present one of these as Graham's view.

## When it runs: intensity

Two levels. **ask** is the default: the skill runs on `/ask-graham` or an explicit "should we build this?" / "is it worth building?". **every-idea** also runs it whenever the user proposes a new project, product, feature, or tool that does not exist yet; a hook adds a one-line nudge to each message, and the agent decides whether the message is a new idea. (Skill)

At both levels it never runs on a ticket or issue, a bug fix, a task inside an already-decided project, or a request to continue existing work. A nudge on such a message is ignored without comment.

One exception, the **structure check**: when a task inside an already-decided project is about to create a new table, a new column on an existing table, a new top-level module, or a new service, run step 2 (local sources, with its parent search) and step 4 only, before the structure is written. It does not ask the comparables question and does not search the web. The turn's first use of this skill declares it: loading this skill with the args `structure-check <the new structure>`, or reading [`structure-check.md`](structure-check.md) before this file. A turn whose first use was anything else (reading this file, or invoking the skill with other args or none) is a full check. The reply always reports what the search found, either way, with no verdict, gate questions, breakdown or closing ask:

- First line `**Structure check:** <the new structure>`.
- Next line, when something matched: `**Found:**` and the matches, plainly: each existing table, column, module or service with a file:line receipt and how it overlaps. If one is a second way to do something the repo already does, the second-pattern flag in step 4 fires.
- Next line, when nothing matched: `**No similar:**` saying there are no similar tables, columns, modules or services, naming the parent and what was searched (for example "no similar tables or columns: searched migrations/ for tables and columns on story_revisions"). An empty search is never silent.
- Then the step-4 red flags.

The Stop check accepts those two opening lines in place of a verdict only in a structure check, and only when no ask-graham invocation in the turn had other args; a full check still needs its verdict. In a structure check only those two lines count: a `**Verdict:**` line or the comparables question does not stand in for them. A task inside a decided project that creates none of these four still gets no ask-graham output. (Skill)

The level comes from the first of these that exists:

1. the nearest `.ask-graham` in the working directory or any directory above it (a per-repo override; one at a workspace root covers every repository and worktree under it);
2. `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/config` (the user's level);
3. the default, `ask`.

Either file holds `intensity=ask` or `intensity=every-idea`, and optionally `stop-check=on` or `stop-check=off` on its own line. Each setting is resolved separately in the order above: a file without a line for one setting falls through to the next file for it. A file that exists but names neither setting counts as `ask` and `on`.

`stop-check=off` turns off the Stop check (a turn that read this skill and ended without a `**Verdict:**` line is blocked once); the default is `on`. (Skill)

### `/ask-graham intensity` and `/ask-graham stop-check`

When the argument starts with `intensity` or `stop-check`, change or show the settings and do not run the check. Run the script beside this file, from the user's working directory:

```sh
node <this skill's directory>/scripts/intensity.mjs                              # show both settings and where each came from
node <this skill's directory>/scripts/intensity.mjs every-idea|ask               # set the user level
node <this skill's directory>/scripts/intensity.mjs every-idea|ask --here        # set the level override at this git repository's root
node <this skill's directory>/scripts/intensity.mjs stop-check on|off            # turn the Stop check on or off for the user
node <this skill's directory>/scripts/intensity.mjs stop-check on|off --here     # the same, for this git repository only
```

Print its output to the user as it is. If the script cannot be run, write the file yourself in the format above, keeping any line for the other setting, and say which file you wrote. A `.ask-graham` file is in the repo's working tree: tell the user it is untracked, and that adding `.ask-graham` to `.git/info/exclude` keeps it out of commits if they do not want to share it.

## Standing rules

- **Delegate the search.** When the "does something else already exist?" search spans more than one repo, or needs more than three searches, hand it to a subagent (or a background read) and keep working on the other gate questions while it runs. (Skill)
- **Using types is never a cost.** Using a type system, types, or typed code is never counted against an ask, flagged, or weighed as complexity. Graham listed "type systems" as something he would kill or defer (Graham #3); Jo disagrees and overrides it: "this skill should NOT be questioning use of a type system". (Jo)
- **Answer from evidence, not by asking.** The gate questions are the agent's to answer from the repo, the open-work sources in step 2, and the conversation. Always ask the comparables question in step 2 (Jo), as an explicit exception. Otherwise put a question to the user only for what no tool can settle: who will own it, or which why matters to them. (Skill)
- **Recommend, then stop arguing.** Once the user has decided ("build it", "park it"), record the decision and do what they said. (Skill)

## Steps

### 1. Name the ask

Restate the ask in one plain sentence: what gets built, for whom, where it lives. If two readings would lead to different verdicts, take the likelier one, say so in one line, and continue.

Done when: one sentence a stranger could act on.

### 2. Search for what already exists

Graham's third gate question is "Something else already exists?" (Graham #1). How to answer it is the skill's own (Skill).

Every run, before any internet search, ask exactly: "Do you want me to research and see if something comparable exists?" Ask at either intensity, on `/ask-graham`, an explicit should-we-build question, or an every-idea nudge. This always-asked question is Jo's rule, not Graham's. Settings invocations still only change or show settings. (Jo) A structure check does not ask it (see "When it runs"). (Skill)

- **No:** check the local sources below only; do not search the web. Read locally available issue or work records; mark remote-only sources *unreachable* for this run. For every recommended package or tool, still complete the upkeep receipt using local evidence and installed-runtime discovery; unavailable remote evidence is explicitly *unknown* because research was declined. Do not fetch around the user's no. Follow [`references/upkeep.md`](references/upkeep.md) in either research path. (Jo)
- **Yes:** also search the internet for comparable open-source and commercial software: libraries, CLIs, apps, AI skills, plugins, MCP servers, and SaaS where relevant. Before evaluating candidates, read [`references/comparables-criteria.md`](references/comparables-criteria.md). Apply its gates first, rank survivors without a weighted total, and show options with pros, cons, measured stats, and an upkeep receipt for every recommended package/tool, each dated and sourced. Stars, repo age, forks, and followers are context only, never scored. This method is the skill's, based on the sources in that reference. (Skill)
- **No answer yet:** ask, then carry on with the local search and other gate questions. Leave web research pending until the user says yes; silence is not consent. If the turn must end while waiting, end it with the waiting reply in "Output": a `**Ask:**` line with step 1's sentence and a `**Gate questions**` block with all five bullets answered from evidence (`Already exists:` may read "local search pending" or name what was found so far), then the exact question alone on the final line, without quotes or a verdict. You can't skip step 1 or step 3 by asking the question; the Stop check blocks a waiting reply missing the `**Ask:**` line, the `**Gate questions**` line, or any of its five bullets, on both harnesses. (Jo, 2026-11-04) When the answer arrives, reload this skill through the host’s Skill or Read tool, then resume step 2 for the same ask. (Skill)

For the local search, check every source below that applies, and record each one as *found*, *nothing found*, or *unreachable*:

- **The current repo or workspace.** Grep for the feature's nouns and verbs, its likely command or file names, and the existing words and commands nearby. Read any hit you would cite.
- **What hangs off the same parent** (technical asks). Name the parent the new thing attaches to, then list its siblings, because a name grep misses a sibling that shares no keyword (a chart pick and `featured_quote_id`). For a table or column: every foreign key and id-array column (`UUID[]`, `int[]`) referencing that parent, and the id-list and single-pick id columns on the parent itself, from `information_schema` or `pg_constraint` (read-only) when a database is reachable and from a grep of the migrations directory either way. For a new column, the parent is its table: list every column already on that table, and the other tables that hold the same kind of thing (a new `chart_candidate_ids` beside `quotes UUID[]` and `featured_quote_id`). For code: what else is registered beside it (the same router, plugin registry, workflow suite, or parent directory) and what else imports the same parent. Name each sibling and the pattern it uses. (Skill)
- **Prior sessions**, if the agent has a way to search them. Has someone asked for this, half-built it, or researched it already?
- **Skills and tools already installed.** The session's own skill list, the user's skills directory (`~/.claude/skills/` on Claude Code), the repo's `skills/` directory if it has one.
- **Where open work lives**, read-only and nothing else:
  - the repo's issue tracker (for a GitHub repo, `gh issue list --search "<noun>"` and `gh pr list --search "<noun>"`);
  - any to-do, roadmap or task file the project's `AGENTS.md` or `CLAUDE.md` names;
  - the user's own sources file, if it exists: `${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/sources.md`. It lists extra places to check, in the user's words: a work database and the read-only query that lists open items, a held-decisions file, a planning folder. Read it with the host's Read tool, then check each source it lists, yourself, in this turn: run a listed command through Bash or eval (narrowed to the ask), open or search a listed path, and look up a source that has neither the way it says. A failed command still counts as run; mark the source *unreachable* with the error. A search a subagent ran does not count, because the Stop check sees only this session's tool calls: run each source here, even when a subagent's findings are also reported. Report every source by its label in the reply's `**Local search:**` block (see "Output"). The Stop check enforces all of this when the file exists, on both harnesses, and blocks once naming the first source left unchecked. A missing file is not an error; record the source as *not configured* and move on. (Jo, 2026-11-04)

  For each, narrow to the ask's key nouns rather than reading everything.
- **For an established external tool or library** that does the job (a schema validator, a scheduler, a vendor API's own enum), one check of what the repo already depends on (`package.json`, lockfile) before anything is built by hand.

Done when: the user has answered the comparables question, any approved web research is complete (or marked *unreachable* with its missing evidence), every applicable source has one of the three marks, every recommended package/tool has the upkeep receipt required by [`references/upkeep.md`](references/upkeep.md), and every *found* names the file, command, issue, work item, or session that overlaps, plus how much it covers (all of the ask, part of it, or a neighbour that would collide with it).

### 3. Answer the gate questions

Graham's questions before a yes, in his order (Graham #1):

1. **Why?** A valid why is more than "Its cool". In Graham's words: "personal productivity is fine, profitability is fine. 'Rising Tide' is great." (Graham #2) Name which one applies, with the evidence. If the only why is novelty, that is the no.
2. **How long lived?** A one-off, something that runs for weeks, or something permanent. Longer-lived means more maintenance to price in.
3. **Something else already exists?** The local search and Comparables result from step 2, in one line. If research was declined or unreachable, state that limit rather than claiming nothing exists.
4. **In scope?** Is this the asker's to build, in this repo and this workstream, or does it belong to another repo, team, or owner?
5. **Who owns it when it's done, or how will it be maintained?** Graham splits this "depending on if corp. or personal work" (Graham #1). Name the owner: the asker personally, a team, an agent, or a scheduled job. "Nobody" is an answer, and it counts against the ask.

Done when: all five have a one-line answer, each with its evidence or marked as a guess.

### 4. Check Graham's red flags (technical asks only)

Skip this step when the ask is not code. Otherwise check the design against each flag and report only the ones that fire:

- **Inventing an enum for a platform you don't control.** "Dont canonize platforms you dont control, if its a third party and they dont provide an enum, your enum is a lie. Ideally, use their enum." (Graham #3)
- **A JSON round-trip.** "Never convert JSON to an object just to convert it back to JSON, use JSON libraries/native." (Graham #3)
- **Hand-built JSON strings.** "Never build a string json by hand." (Graham #3)
- **Building our own type system.** Writing a homegrown type system, runtime typing layer, or schema layer when an established one exists (TypeScript, Zod, the platform's own schema) is a red flag that routes back to "something else already exists?" with a strong default to the existing tool. "...though if we are going to build our own that is stupid." (Jo)

Using types, adding types, or typing an untyped module never fires a flag (Jo, standing rule above).

Skill addition: also flag a collision step 2 found, such as a new command word that is already taken with a different meaning. (Skill)

Skill addition: **a second pattern where one exists.** When the parent search in step 2 finds an existing way to attach or store the same kind of thing, the design uses that pattern or says in one line why it cannot. It fires on a new table, a new join table, or a new side store where the parent already carries a column or list for that role. This is the skill's rule, prompted by the 2026-10-28 review of a chart-pick table that belonged as a `story_revisions` column. (Skill)

Done when: each flag is marked *fires* (with the line of the design that trips it) or *clear*.

### 5. Pick the verdict

Size first, with Graham's 2-minute rule from GTD: "if we can do it in under 2 minutes, do it now. If not, its a task in the back log. If you want, you can prioritize it now." (Graham #4)

| Verdict | When | Source |
|---|---|---|
| **do it now** | It takes under two minutes and the gate questions pass. | Graham #4 |
| **start now** | Bigger than two minutes, the gate questions pass, and waiting has a named cost: something is blocked, something piles up, or a deadline exists. | Graham #4 for the option; the cost-of-waiting test is the skill's (Skill) |
| **later** | Bigger than two minutes, the gate questions pass, and nothing gets worse while it waits. | Graham #4 |
| **don't build** | The why is only "it's cool", something existing already covers it, it is out of scope, or nobody would own it. | Mapping is the skill's (Skill), from Graham #1 and #2 |

When two designs, or two asks, both pass: "fewer lines of code? less complexity means less to maintain. Future functionality is often YAGNI" (Graham #5). Pick the smaller one and name what it leaves out. Type annotations never count as lines or complexity here (Jo).

Before the verdict on any ask bigger than two minutes, run the pattern-check skill (the `pattern-check` plugin, when installed): for each piece the ask would add, find the existing pattern in the repo that does its job and record reuse, replace, or new with a reason; a `new` row whose nearest pattern is close fires the second-pattern flag in step 4. (Skill)

Done when: exactly one verdict, with a one-line why that names the gate answer or cost that decided it.

### 6. Break it down, scaled to size

"Case by case. The bigger the task the larger breakdown." (Graham #6)

- **do it now / don't build**: no breakdown.
- **start now or later, small** (a single task of hours to a couple of days): one task with acceptance criteria.
- **start now or later, bigger**: break it down fractally, "onion skin": **High Level Design (HLD) → Epics → Stories → Tasks | Acceptance criteria**. "Tasks should be measured in hours or a few days at the most." (Graham #6) Go only as deep as the size needs.

Every work item states the requirement and how to tell it is met. Never write untested implementation into a work item as a requirement: "implementation is for the dev." (Graham #6) Naming the existing file or command that the work touches is context, which is fine; prescribing the code is not.

Done when: every task has acceptance criteria a reviewer could check, and no task exceeds a few days.

## Output

While the comparables answer is pending, use the waiting reply below: step 1's `**Ask:**` line, step 3's `**Gate questions**` block with all five bullets, any local findings worth reporting, and the exact question from step 2 alone on the final line. Omit the verdict and closing ask. Both labelled pieces are required, outside code fences and quotes; the Stop check names whichever is missing. (Jo, 2026-11-04: "you can't skip step 1")

```
**Ask:** <step 1's one sentence: what gets built, for whom, where it lives>

**Gate questions** (Graham #1)
- Why: <answer + evidence>
- How long lived: <answer>
- Already exists: <"local search pending", or what step 2 has found so far>
- In scope: <answer>
- Owner / maintenance: <answer>

**Local search:**
- <each sources-file label>: <found, naming the overlap | nothing found | unreachable, with the error>

Do you want me to research and see if something comparable exists?
```

With a sources file, both replies also carry the `**Local search:**` block: one line per source the file lists, its label (any case, bold optional) and one of *found*, *nothing found* or *unreachable*. Outside code fences and quotes only. Without a sources file the block is optional. (Jo, 2026-11-04)

After the user answers, use the completed-check template below. A structure check uses the shape in "When it runs" instead: its `**Structure check:**` line, its `**Found:**` or `**No similar:**` line, and the red flags. (Skill)

```
**Verdict:** <one of the four verdicts: do it now, start now, later, don't build>. <one-line why>

**Needs you:** <only what no tool could answer: owner, which why matters, a collision to rule on. Omit the line when there is nothing.>

**Gate questions** (Graham #1)
- Why: <answer + evidence>
- How long lived: <answer>
- Already exists: <step 2 result, naming the overlap>
- In scope: <answer>
- Owner / maintenance: <answer>

**Local search:**
- <each sources-file label>: <found, naming the overlap | nothing found | unreachable, with the error>

**Comparables** (Skill criteria; research choice: Jo)
<If research was declined, write "not researched (user said no)" and omit the options table. Keep local build sizing in the verdict and breakdown. Otherwise use the options table below, using the default columns in references/comparables-criteria.md. If approved research is unreachable, say so and name the missing evidence. For every recommended package/tool—including local-only recommendations—include the five-field upkeep receipt from references/upkeep.md.>

| Name and link / version or plan | Gate result + confidence | Measured stats (date, source, window) | Pros | Cons |
|---|---|---|---|---|
| <Confirmed survivors only, in rank order> | <pass + confidence> | <kind-specific evidence> | <fit> | <limits> |
| build our own | <same essential requirements, or unknown> | <estimated effort and upkeep, with basis; unknown where unmeasured> | <control / fit> | <cost / maintenance> |

**Upkeep** (Jo's requirement; collection recipe: [`references/upkeep.md`](references/upkeep.md))
<For every recommended package/tool, include its generated or faithfully transcribed upkeep line. If no recommendation exists, omit this field.>

<List unknown-gate candidates separately with their missing essential evidence; list disqualified candidates separately with their failed gate and evidence. Say when none meets the requirements. Include the build our own row as a baseline in approved comparisons.>

**Red flags:** <the flags that fired, each with its source; or "none fired"; or "not a technical ask">

**Breakdown:** <omitted for do it now / don't build; HLD → Epics → Stories → Tasks with acceptance criteria otherwise>

**Closing ask:** <one decision, restating its full subject, with a recommendation>
```

The closing ask names the thing in full ("Start the CSV export for the billing page now, or leave it for later?"), never a back-reference like "do you want that?".

## The sources file

`${XDG_CONFIG_HOME:-$HOME/.config}/ask-graham/sources.md` is optional and lives on the user's machine, never in a repo. It is plain Markdown: one bullet per source, saying what it is, where it is, and how to read it without changing it. For example:

```markdown
- **Prior sessions:** `my-history-tool search --limit 5 -- "<the ask>"`
- **Open work items:** `sqlite3 -readonly ~/work/tracker.db "SELECT id, title FROM items WHERE status='open';"`, narrowed with `AND title LIKE '%<noun>%'`.
- **Decisions waiting on me:** `~/notes/HELD.md`
```

Every source it lists is read-only for this skill. If a listed command would write anything, skip it and record the source as *unreachable*.

How the Stop check reads each bullet: the bold label names the source. A bullet with a backticked command needs a Bash or eval call containing the command's first two words (three when the second is `node`, `bun`, `python3`, `sh`, `zsh` or `npx`); text from a placeholder such as `<the ask>` on is not required. A bullet with only a path (backticked or bare; `*` matches any part) needs a tool call naming that path. A bullet with both counts as a command. A bullet with neither needs its line in `**Local search:**`. A bullet with no bold label is ignored.
