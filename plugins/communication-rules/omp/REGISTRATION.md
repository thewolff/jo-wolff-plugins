# REGISTRATION.md — how this adapter would go live (it has not)

Status: **unregistered**. `communication-rules-omp.ts` exists in this repo, is tested by the
suite beside it, and is loaded by nothing — no OMP seat, seat profile, or extension directory
references it, and `~/.omp/agent/extensions/` does not contain it. This file exists so that
going live is a deliberate act with a written reversal, not an accident of directory
auto-discovery.

## Registration steps NOT TAKEN

Two candidate sites; either works, pick one:

1. **Shared auto-discovery** — symlink the file into the extension directory every omp
   process loads unconditionally:

   ```
   ln -s /Users/jowolff/code/jo-wolff-plugins/plugins/communication-rules/omp/communication-rules-omp.ts \
         ~/.omp/agent/extensions/communication-rules-omp.ts
   ```

   Cost of this site: every omp process on the machine loads it — the `extensions/*.{ts,js}`
   directory is scanned unconditionally and the `extensions` settings array can only ADD to
   that set — so this is the broad arm. The live precedent running exactly this way is
   `newdle-hooks.ts`, whose `pi.on("session_stop", …)` registration block
   (`~/.omp/agent/extensions/newdle-hooks.ts:1259-1316`) is the shape this adapter copies.

2. **Per-seat explicit registration** — reference the file from the one seat's launch path
   (`launch-seat`'s explicit extension list, or the seat profile's hooks dir) so only that
   seat loads it. Narrower blast radius; the right choice for the first live proof.

Environment to set at registration:

- `COMMUNICATION_RULES_PLUGIN_ROOT` — set ONLY if the plugin is not at
  `/Users/jowolff/code/jo-wolff-plugins/plugins/communication-rules` (for instance after a
  move into the marketplace cache). The adapter spawns
  `node "$ROOT/hooks/communication-rules-stop.mjs"` with this override.
- `COMMUNICATION_RULES_OMP_MODE` — **leave unset for the first live run.** Unset, or any
  value other than exactly `block`, means warn-only. Setting it to `block` at registration is
  the deliberate arming act — the moment OMP seats start actually gating turns. That is Jo's
  call, not the installer's.

## Exact reversal

1. Remove the registration reference:
   `rm ~/.omp/agent/extensions/communication-rules-omp.ts` (or drop the seat-profile /
   launch-seat reference).
2. Delete the adapter's state file:
   `rm ~/.claude/.communication-rules-state/omp-adapter-failures.json`.
   Its `warnings.log` / `errors.log` lines live in the plugin's shared logs; leave them.
3. `git revert <this commit's sha>` in `/Users/jowolff/code/jo-wolff-plugins`.

## The kill switch (works the moment this is live)

```
touch ~/.claude/.communication-rules-off
```

Checked inside the CLI per invocation — never cached, effective within one turn, and it
already governs the Claude side. The adapter has no kill switch of its own: one switch, one
place.

## Cheapest honest live proof (NOT performed)

One disposable canary seat — not a working seat — plus one message, ~5 minutes, zero risk to
working seats:

1. Register the adapter for the canary seat only (per-seat site above), mode unset (warn).
2. Make the seat produce a final message that violates a rule — e.g. name-the-artifact.
3. Expect in warn mode: exactly one line in
   `~/.claude/.communication-rules-state/warnings.log` reading
   `rule=omp-adapter mode=warn-only reason=…`, and NO continuation turn — the turn settles
   normally, which is what warn-only means.
4. Block mode is proven only after Jo arms it (`COMMUNICATION_RULES_OMP_MODE=block`): the
   same message then yields `{decision:"block"}` and one forced revision turn.

Provenance note, so the canary is read honestly, in both states of the world: the PLUGIN's
shipped default arms name-the-artifact at warn, so at plugin-default a violation writes the
CLI's OWN warn line and the adapter sees no verdict — that run proves the wiring (spawn,
payload, text extraction) but not the downgrade. Jo's installer (2026-09-21, sha256
398180ee…) seeds the shared profile with name-the-artifact at BLOCK, so POST-INSTALL a
violation exercises the adapter's downgrade at default config: the warn line in step 3 is
the adapter's own, exactly the thing worth proving. Pre-install, arm the rule block in the
canary seat's ~/.claude/communication-rules.json first to reach the same proof.
