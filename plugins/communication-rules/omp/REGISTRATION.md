# REGISTRATION.md — how this adapter would go live (it has not)

Status: **unregistered**. `communication-rules-omp.ts` exists in this repo, is tested by the
suite beside it, and is loaded by nothing — no OMP seat, seat profile, or extension directory
references it, and `~/.omp/agent/extensions/` does not contain it. This file exists so that
going live is a deliberate act with a written reversal, not an accident of directory
auto-discovery.

## Registration steps NOT TAKEN

Two sites; pick one:

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

2. **One omp process only** — pass the file with `-e` (`--extension`) to a single omp
   launched by hand, in a scratch directory:

   ```
   cd "$(mktemp -d)" && /Users/jowolff/.bun/bin/omp \
     -e /Users/jowolff/code/jo-wolff-plugins/plugins/communication-rules/omp/communication-rules-omp.ts
   ```

   The `omp` path is absolute because a seat pane's `PATH` puts the launcher shim
   `~/.omp/agent/seat-launchers/seat-bin/omp` first, and that shim adds its own flags.

   Only that process loads the adapter; nothing on disk changes. It still loads every file
   in `~/.omp/agent/extensions/`, as every omp process does. Narrower blast radius; the
   right choice for the first live proof.

   Verified 2026-10-01 against omp's installed source and a live run. `-e` and
   `--extension` push onto the same list (`setExtension` in `cli/flag-tables.ts` of
   `@oh-my-pi/pi-coding-agent`), which `main.ts` hands to the session as
   `additionalExtensionPaths`. A file path is loaded as one module and is not scanned as a
   package root. The live run used a stand-in probe extension, not this adapter, under a
   throwaway `HOME`: `omp -p -e <probe>.ts` called the probe's factory in that process,
   and nothing was written under the real `~/.omp`.

   There is no per-seat site for a seat started by `launch-seat`
   (`~/.omp/agent/seat-launchers/launch-seat`). It passes the same fixed
   `--hook "$ADAPTER" --hook "$COMPACTION_OWNER" --extension "$SEAT_REGISTRY"` set to every
   seat, in both the foreground path and the background `seat-bin/omp` shim, and has no slot
   for one more extension on one seat. `OMP_SEAT_ADAPTER` *replaces* `newdle-hooks.ts`
   rather than adding to it. Registering a managed seat narrowly would mean changing
   `launch-seat`, which this file does not document.

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

1. Remove the registration reference: `rm ~/.omp/agent/extensions/communication-rules-omp.ts`
   for the shared site, or exit the `omp -e` process for the one-process site (nothing on
   disk to undo). The adapter's `warnings.log` / `errors.log` lines live in the plugin's
   shared logs; leave them.
2. `git revert <this commit's sha>` in `/Users/jowolff/code/jo-wolff-plugins`.

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

1. Register the adapter for the canary only (the one-process site above), mode unset (warn).
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
