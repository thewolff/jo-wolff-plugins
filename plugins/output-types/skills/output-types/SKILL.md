---
name: output-types
description: Label assertions of fact, and only those — CLAIM with a receipt, CITE with a fetched source, GUESS with a basis — so a reader can tell what was checked from what was assumed. Use before writing any report, review, audit, plan, summary, recommendation, or answer someone will act on. Use when about to state a fact about a codebase, a vendor's behaviour, a library default, an error code, a runtime limit, or a measurement. Use whenever about to assert something not verified this session, or when asked to show your work, say what you actually checked, stop guessing, be rigorous, cite sources, or say how confident you are.
when_to_use: writing a report; writing a review or audit; writing a plan; summarising findings; making a recommendation; answering a question that will be acted on; stating what a library, API, database, or framework does; quoting a number or a measurement; reporting what a subagent returned; saying something you are not sure about; being asked to show your work, cite your sources, or stop guessing
license: MIT
---

# Output types

Three labels, for assertions of fact only: **CLAIM** (checked this session, with a receipt),
**CITE** (from an outside source, with the URL fetched or a live test), and **GUESS** (not
verified, with its basis). Everything else stays plain prose.

The whole contract, stated once, is `${CLAUDE_SKILL_DIR}/reference.md`. Read it now, before
writing anything someone will act on: the receipt rules, the seven rules, what unlabeled
prose still owes, rendering, degraded reports, and the rules for handing a command to a
person to run are all there and nowhere else.
