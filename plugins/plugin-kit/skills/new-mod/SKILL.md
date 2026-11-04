---
name: new-mod
description: Write a Claude Code mod for a plugin in this repository so that what it draws reads well in the terminal and in Claude Desktop, and says what it can't draw where nothing draws. Use when asked to add a mod, a band above the prompt, a status line, a toast, a pane, or a /command that draws, or to fix a mod that shows in one host and not the other.
---

# New mod

Pick the surface by what the signal is for, draw it so a person can read it in both hosts,
register it in the shape the engine expects, prove it with the real session payloads, and ship
it with the version bump. Anthropic's pages cover the API; this skill covers what they leave
out: which surface to use, what each host does to it, and how it looks. Look a surface, element
or limit up in `${CLAUDE_SKILL_DIR}/reference.md`; start a hooks module from
`${CLAUDE_PLUGIN_ROOT}/templates/mod/register.mjs`.

## Steps

1. **Pick the surface.** One row per signal; the surface is the decision, not a preference.

   | The signal | Draw it with | Why |
   |---|---|---|
   | Standing: the person must notice it before they type (away, questions held, a red build) | The band above the prompt: `on('ui.render', { component: 'AbovePrompt' }, …)` returning a `Box` with colour, a border, bold text, and a `Button` where pressing does something | The only site with colour and controls that both the terminal and Desktop draw (reference.md render sites; interface.md "Pick where to draw") |
   | The moment something happens (a job finished, a message landed) | `$.ui.toast(text)`: plain text, 4 s unless `timeoutMs` says otherwise | Transient by design; Desktop cuts it at 240 characters, VS Code at 500 (api.md; reference.md limits; `reference.md` section 1) |
   | A one-liner where no band draws | `$.ui.status(text)` as a fallback only, until your `AbovePrompt` render hook has been called once this session; then `$.ui.status(undefined)` and keep it clear (brb 0.4.0's rule) | The terminal draws it with a warning sign and the plugin name, so it reads as a warning (issue #99647); Desktop draws a grey 32-character footnote in the footer, unreadable as a signal and a duplicate beside a band showing the same thing (`reference.md` section 1). A band that has been asked for once is the signal from then on |
   | Neutral live figures (counts, elapsed, context fill) | The band, or a tree on `{ component: 'SessionMode' }` | The status line's warning look is wrong for figures (#99647); Desktop cuts a `SessionMode` tree at about 28 characters (#100116) |
   | A note for the person that Claude need not read | `$.ui.log(text)` | A dim transcript row in the terminal; on Desktop one footnote line by the composer, gone after 10 s (api.md; `reference.md` section 1) |
   | Anything under `claude -p`, the Agent SDK, or a cloud session | Nothing draws: return `{ text }` from `turn.complete`, or answer the command with `{ text }` | overview.md "Where mods run" |
   | Never | `PromptHint` on Desktop (never raised, #100116); `$.ui.notify` on Desktop (`no-surface`, api.md); a pane opened unasked (waits below 144 columns, interface.md) | |

2. **Write for both hosts.** Desktop is headless: it starts Claude Code with
   `--input-format stream-json`, so `session.start` arrives as `{ surface: null, isInteractive: false }`
   and still draws the band, the status line, toasts and log lines. Never gate on `e.surface`;
   the brb badge (0.3.0) and the ledger pane did, and drew nothing on Desktop. Read `e.surface`
   only inside a `ui.render` hook, and only to swap an element the app lacks (`Raster`, `Image`,
   `Svg`). Other facts to design around:
   - The terminal can collapse the band (Ctrl+X Ctrl+A); the mod cannot tell, and no hotkey
     fires while it is collapsed. Once the band has been asked for, the status line is clear,
     so a person who collapses it later sees nothing of yours until they expand it; that is
     accepted, not detected. For something the person has to answer, also raise a
     `$.ui.toast` when it first appears (interface.md "When the user collapses the band").
   - Every mod shares the band. Put `await next(e)` among your `Box`'s children so the mods
     after yours keep theirs; give that `Box` no `width`, `height` or `position`
     (troubleshoot.md "Another mod's band shows and yours doesn't").
   - One status line per plugin; the next call replaces it (d.ts `status`). Redraws throttle
     to 10 a second, 30 in the terminal; a hook has 10 s of its own time; `$.ui.invalidate`
     calls that come sooner coalesce (reference.md limits).
   - VS Code draws panes and the shared sites, not the band; it caps a status line at 200
     characters and a toast at 500, and ignores `hotkey`, `plain`, `size` (interface.md "Draw in
     the VS Code extension").

3. **Make it readable.**
   - Single-width symbols (`·`, `…`, `▸`), never emoji: a two-cell glyph breaks column
     alignment in the terminal and the `clip()` count on every surface.
   - Colour never carries state alone: pair it with a word or a symbol, since the status line
     and toasts are plain text on Desktop and the person's terminal theme may drop the colour.
   - Any one-line surface reads at 40 characters or fewer, and the first 32 carry the point,
     since Desktop's footer cuts a status line there. Trim in this order: the note, then the
     suffix, then the count; cut with `clip()` and a single `…`, never a mid-word break.
   - The manifest `name` is the label the person sees before a status line in both hosts
     (`displayName` is not drawn, #99647 comment). Choose it for reading: `brb`, not `brb-badge`.
   - One headline in bold colour, one sub-line muted (`dimColor`); nothing else on the band.
   - A `Button` only where pressing does something typing cannot: a plain `Button` with a
     `hotkey` and a `key`; name the key in the label so the terminal shows what to press.

4. **Register in the engine's shape.** Export `register(on, options)`; `options` holds the
   manifest's `userConfig` values (reference.md "Files"). Follow the template:
   - Start every timer in `session.start` with `$.clock.every(ms, fn)` and `return next(e)`
     without awaiting the timer; the session starts at once (api.md "Run work in the
     background"). One poll at 5 s or slower for file-backed state; a 1 s probe only for a call
     as cheap as `$.fs.exists`.
   - Cancel every timer and clear the status line in `session.end` (all `session.end` hooks
     share 1.5 s). Timers also stop on a hot reload, and `session.start` runs again then.
   - Call `$.ui.invalidate('ui.render')` after every state change the band reads; the engine
     never redraws on its own for a variable.
   - An error in a timer callback goes to the debug log only (api.md). Route every fault through
     one top-level function that logs once per distinct message with `$.ui.log` and never throws.
   - Keep validation happy: spell every call `$.ns.method`, pass `$` only to top-level functions
     of the same file, string-literal event names, relative imports, no node builtins,
     `$.env.get` with a string literal (create.md "Check what Claude Code reads from your mod").

5. **Prove it on both hosts.** `claude plugin test` runs the kit offline (no session, no sign-in,
   no network). Start each session with the real payloads, never an invented `surface: 'desktop'`:
   ```ts
   import { expect, mock, test } from 'claude-code/testing'
   const terminal = ($) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
   const desktop = ($) => $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
   ```
   Stub `session.start`, `ui.status`, `ui.log`, `fs.exists`, `fs.read`, `env.get`, and use
   `mock.clock(on)` to advance the poll; assert the status text and the band (`$.ui.mount` with
   `surface: 'terminal'` and `'desktop'`, then `ui.find`) in both. `claude plugin validate
   <dir>` lists the hooks and calls the engine reads. Then look at it live: a screenshot in a
   terminal session with `--plugin-dir`, and one in the Desktop Code tab, before saying it
   draws. The kit checks the tree, not the paint, and it never caught the brb or ledger gate.

6. **Ship it.** `hooks/hooks.json` gets `"modules": ["../mods/<name>/register.mjs"]`, the path
   relative to `hooks.json`; the plugin's `version` moves in `.claude-plugin/plugin.json` and
   `package.json` (an installed copy is cached by version, so no bump means no change reaches
   it); `CHANGELOG.md` says why in one paragraph (what the person saw, what the cause was) above
   the Fixed/Added list; the README names the Claude Code version tested. Then `node --test` and
   `ledger gate check --plugins <name>` as `new-plugin` step 8 says.

## When this can't run

- `claude plugin test` prints `hooks modules are turned off` and exits 1: `disableAllHooks` or
  the organization's policy blocks mods in this shell (troubleshoot.md "Check whether mods can
  load"). Fix the setting, or hand the run to a shell where `claude plugin test` from an empty
  directory prints `no hooks module to load`.
- `claude plugin validate` fails with `is used as a value`, `is not a string literal`, or `a
  dynamic import()`: a validation rule from step 4 is broken on the named line; rewrite that
  line, never work around the scan.
- The mod loads and draws nothing: `claude --debug-file ./mod.log --plugin-dir <dir>`, then
  search the log for `hook skipped` (the tree broke a rule the line names) or `answered
  ui.render without next()` (another mod replaced your band). Fix what the line names.
- The band shows `plugin panel hidden`: the person collapsed it; Ctrl+X Ctrl+A expands it, and
  the mod cannot. The mod cannot detect the collapse either, and its status line is already
  clear once the band was asked for, so meanwhile the person sees only toasts; that is why
  anything they have to answer also raises one.
- A screenshot of Desktop is not available (no Desktop on this machine): say so in the
  CHANGELOG entry and the report; the kit's `surface: null` session is the fallback evidence, not
  a substitute.
