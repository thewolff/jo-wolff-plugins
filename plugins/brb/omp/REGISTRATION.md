# REGISTRATION.md — how the OMP adapter goes live

`brb-omp.ts` is registered by the plugin install. `package.json` declares it under
`omp.extensions`, and OMP loads extension modules declared there for marketplace installs:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install brb@jo-wolff-plugins
```

That one module does three jobs for the main session (see its header for the event mapping):

- **The three words.** On `input`, when the whole typed text is `brb` (a note may follow),
  `back` or `pending`, it returns `{ handled: true }` at once so no turn starts, then spawns
  `hooks/user-prompt-submit.mjs` with the text as the prompt and shows the hook's block reason
  (the confirmation, or the digest) through `pi.sendMessage({ display: true })` without a
  `triggerTurn`, falling back to `ctx.ui.notify` when the host has no `sendMessage`. Any other
  text is left to the host.
- **The away instruction.** On `before_agent_start` it spawns `hooks/session-start.mjs`; while
  the session is away the hook's `additionalContext` becomes a hidden custom message
  (`customType` `brb-away`) for that turn. Home → nothing is added. Subagent sessions are
  skipped.
- **Stop.** On `session_stop` it spawns `hooks/stop.mjs` with `BRB_HARNESS=omp` and returns
  the core's verdict: `{ decision: "block", reason }` sends the agent back to work (the
  keep-working reason, or the backstop's `brb: N item(s) moved to the digest; …` when the reply
  showed an ask); a `systemMessage` (an on-fire line, an idle notice) goes to `ctx.ui.notify`. Under the `omp`
  tag the core leaves out the OSC 9 `terminalSequence`, since the adapter is the one that
  notifies. OMP has no continuation cap on explicit blocks; the loop ends by the core's own
  rules (an `idle:` line, nothing new on a tool-less continuation, two tool-less stops, three
  continuations in a row with nothing new).
- **One session id.** Every spawn carries `ctx.sessionManager.getSessionId()`, the id that is
  stable across OMP's provider-id rotations, so the three hooks share one state directory.
- **Fail open.** A spawn that fails, exits non-zero, prints junk or outruns its budget (5 s for
  the prompt and start hooks, 10 s for stop) is one `omp-adapter …` line in
  `${XDG_STATE_HOME:-~/.local/state}/brb/errors.log`; the word is still handled (it never
  reaches the model), the turn starts without the context, the stop is allowed.

Node for the spawns: `process.execPath` unless the host is Bun, then the first `node` on PATH
or in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; `BRB_NODE` overrides.

The adapter's handlers and helpers are covered by `omp/brb-omp.test.mjs` with a fake runner
and one real spawn of the plugin's hooks. A live omp session delivering these events has not
been run against this version.

## Fallback: register without the marketplace

Use these only when the marketplace install is not an option. Neither is needed after it.

1. **One omp process** — pass the file with `-e` (`--extension`) to a single omp launched by
   hand. Only that process loads the adapter; nothing on disk changes.

   ```
   omp -e <your-checkout>/plugins/brb/omp/brb-omp.ts
   ```

2. **Every omp process (manual symlink)** — the `extensions/*.{ts,js}` directory is scanned
   unconditionally:

   ```
   ln -s <your-checkout>/plugins/brb/omp/brb-omp.ts ~/.omp/agent/extensions/brb-omp.ts
   ```

   Do not combine this with the marketplace install: two loaded copies handle every word
   twice and check every stop twice.

## Environment

- `BRB_PLUGIN_ROOT` — normally unset. The adapter resolves the plugin root from its own
  location (the directory above `omp/`). Set it only to point the adapter at another copy.
- `BRB_HARNESS` — never set it by hand. The adapter puts `omp` on its children's env; that tag
  is how the stop core knows a stop came from OMP. Claude Code never sets it.
- `BRB_NODE` — the node binary for the spawns, when the resolution above picks wrong.
- `BRB_DESKTOP_NOTIFY=off` — no `osascript` desktop notification for on-fire lines.

## Exact reversal

1. `omp plugin uninstall brb@jo-wolff-plugins` for the marketplace install;
   `rm ~/.omp/agent/extensions/brb-omp.ts` for the symlink; or exit the `omp -e` process
   (nothing on disk to undo).
2. State is under `${XDG_STATE_HOME:-~/.local/state}/brb/`; delete the directory, or leave it
   for `node scripts/prune.mjs --days 30` (the nightly canary runs it).
