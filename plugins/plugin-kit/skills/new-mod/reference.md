# new-mod reference

What each surface a mod can draw on does in the terminal and in Claude Desktop, with the receipt
for each row. Read `SKILL.md` first; this file is for looking one thing up.

Receipt shorthand. `CLI N` is `strings -n 6 ~/.local/share/claude/versions/2.1.318`
line N. `ION N` is `strings -n 6 /Applications/Claude.app/Contents/Resources/ion-dist.asar` line
N (the Desktop renderer; `app.asar` is only the bridge). Docs pages are under
`https://code.claude.com/docs/en/plugins/mods/` and are named by file. The d.ts is
`https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts`;
where it and the docs disagree, the docs say to trust the copy Claude Code writes into
`.claude-plugin/types/` for your build (create.md, "Get type definitions for your version").

1. [Surfaces](#1-surfaces)
2. [Elements by surface](#2-elements-by-surface)
3. [Render sites by surface](#3-render-sites-by-surface)
4. [Limits that shape a drawing](#4-limits-that-shape-a-drawing)
5. [Session payloads by host](#5-session-payloads-by-host)
6. [Official pages](#6-official-pages)

## 1. Surfaces

| Surface | Call | Terminal | Desktop | Styling | Stays | Receipt |
|---|---|---|---|---|---|---|
| Band above the prompt | `on('ui.render', { component: 'AbovePrompt' }, …)` returns a tree; `$.ui.invalidate('ui.render')` redraws | A strip above the prompt, shared by every mod; the person can collapse it (Ctrl+X Ctrl+A) and the mod cannot tell | An engine band about 11 lines tall that scrolls (`max-h-[calc(11lh+40px)]`) | Full tree: `Box` border and background, `Text` colour, bold, inverse; `Button`, `Input`, `Select`, `Markdown`, `Link`, `Code`; `Svg` on Desktop only | While the hook returns a tree | reference.md render sites ("Terminal, Desktop"); interface.md "When the user collapses the band"; CLI 391561 (`AbovePrompt:["terminal","desktop"]`); ION 4082 (`Eb="above-prompt"`) |
| Status line | `$.ui.status(text)`; `undefined` clears; one per plugin | `⚠ <plugin>: text`, a pinned low-priority notice under the prompt | Footer strip, right of centre next to the model picker; `text-footnote text-muted-as-secondary`, `max-w-[32ch]` truncate; grey plugin `name` prefix, no icon; extra plugins collapse into a "+N more plugin status lines" popover | Plain text | Until replaced or cleared | api.md "Show something without starting a turn"; d.ts 2142-2153; CLI 416805 (`plugin-status-`, `pinned:!0`); ION 4082 (`fy="max-w-[32ch]"`); issues #99647 and its 2026-10-25 comment |
| Toast | `$.ui.toast(text, { timeoutMs })` | Fullscreen: a box at the top right; classic renderer: one line at the right under the prompt; at most three drawn at once | App info toast, text cut at 240 characters; shown only while that session's view is open | Plain text | 4 s default; Desktop caps at 60 s; `timeoutMs` 1 to 60000 | api.md; reference.md limits; troubleshoot.md "A toast doesn't appear"; ION 3900 (`cr=4e3,lr=6e4`); ION 4082 (`ty()` 240) |
| Log line | `$.ui.log(text)`; `{ to: 'debug' }` for the debug log only | A dim `● <plugin>: text` row in the transcript; Claude does not read it | Not a transcript row: one `line-clamp-2 … text-footnote` line by the composer, replaced by the next line, gone after 10 s | Plain text | Terminal: stays in the transcript; Desktop: 10 s | api.md; d.ts 2098-2112; ION 3198 (`data-engine-log-line`); ION 4082 (`Kv=1e4`) |
| Pane | `$.ui.open({ id, title, focus, closeOnEscape, rows, columns })`, `$.ui.close`, `$.ui.panes`; tree on `{ component: 'Pane' }` | Sidebar in a wide fullscreen terminal, else framed above the prompt; opened unasked it waits below 144 columns (110 once the person opened it) and resolves `{ isPlaced: false }` | Rail pane (`data-engine-rail-pane`) | Full tree | Until closed | interface.md "Open a pane at the right time"; reference.md limits; CLI `var Tde=110`; ledger `mods/pane/register.mjs:114,125` |
| Mode chip | tree on `{ component: 'SessionMode' }` | Footer mode labels | Footer chip, right-aligned, cut with an ellipsis at about 28 characters; a `props.modes` rewrite is not drawn, only a returned tree | Tree | Per render | reference.md render sites; issue #100116; #99647 comment of 2026-10-25 ("about 28 characters … still so in 2.1.310"); ION 4084 |
| Hint line | tree on `{ component: 'PromptHint' }` | The hint under the prompt | Never raised | Tree | Per render | reference.md lists "Terminal, Desktop"; issue #100116 reports it is never called on Desktop (2.1.289); ION 3198 has a `data-engine-hint` node |
| Spinner, messages, tool rows, question dialog | tree or changed `props` on `Spinner`, `UserMessage`, `AssistantMessage`, `ToolUse`, `ToolResult`, `ToolGroup`, `CommandOutput`, `AskUserQuestion` | Drawn | Drawn | Restyle, replace, or wrap `await next(e)` | Per render | reference.md render sites; interface.md "Change what Claude Code already draws" |
| Terminal-only sites | `TurnDuration`, `InfoNotice`, `ToolProgress` | Drawn | None | Tree | Per render | reference.md render sites |
| Prompt suggestion | `$.prompt.suggest(text)` | Dim placeholder in an empty prompt; Tab accepts | Same | Plain text | Until the person types | reference.md methods; CLI `ui_prompt_suggest` schema; ION 5 hits |
| Permission notice | `$.ui.notice(toolUseId, text)` | Context text on an open permission request | Same | Text | While that request is open | reference.md methods |
| OS notification | `$.ui.notify(text, { title })` | The terminal's channel (`preferredNotifChannel`: iTerm2, kitty, ghostty, bell) | Resolves `{ isSent: false, reason: 'no-surface' }`; only the person's `Notification` settings hooks run | Text and title | One shot | api.md reason table ("the desktop app" under `no-surface`); CLI 398694 |
| Turn-end line | `turn.complete` hook returns `{ text }` | A line under the answer | Rendering unverified | Text | Stays in the transcript | reference.md turns table; ledger `register.mjs:183-202` |
| Sound, speech | `$.audio.play`, `$.audio.speak` | Plays | No surface gate found; untested | n/a | One shot | reference.md methods; CLI `command:"afplay"`, `command:"say"` |

Not reachable from a mod: a window title, dock badge, tray item, or alert. The full `$` method list
(CLI 392449) has no such name. Desktop has no handler for `ui_notify`, `ui_placed`, `ui_notice`
or `plugin_notification` (0 hits in `ion-dist.asar` and `app.asar`); its parser maps only
`ui_toast`, `ui_status` and `ui_log` (ION 3900), so those three are plain text with no colour.
The permission prompt is not a render site (overview.md "Decide whether to trust a mod").

## 2. Elements by surface

From reference.md "Elements". A check means the app draws it.

| Element | Terminal | Desktop | VS Code | Note |
|---|:-:|:-:|:-:|---|
| `Box` | yes | yes | yes | VS Code ignores `position`, `alignSelf`, `borderDimColor`, `hover` |
| `Text` | yes | yes | yes | Terminal ignores `size`, `mono`, `tabular`; `weight` `semibold`/`bold` draw bold; `bold` deprecated for `weight` from v2.1.299; a tree with `size`/`weight`/`mono`/`tabular` does not draw before v2.1.299 |
| `Button` | yes | yes | yes | VS Code ignores `hotkey`, `plain`, `autoFocus`, `action`, `variant`, `role`; `variant` is `primary` or `secondary` only; children other than one string need v2.1.295 |
| `Link` | yes | yes | yes | Desktop and VS Code draw it as text unless `href` is `https:` or `http://localhost`, no `@`, canonical spelling |
| `Code` | yes | yes | yes | VS Code draws plain text, no colours or line numbers |
| `Markdown` | yes | yes | yes | Content in `text`, not `children` |
| `Input`, `Select` | yes | yes | yes | Every one needs a `key`; `rows` on `Input` needs v2.1.301 and VS Code ignores it |
| `Svg` | no | yes | yes | `source` up to 131,072 characters |
| `Client` | yes | yes | no | A second file of yours; `ui.fault` on failure (v2.1.289) |
| `Raster`, `Image` | yes | no | no | Grid of cells; PNG/RGBA up to 2 MiB |

## 3. Render sites by surface

From reference.md "Render sites"; `e.surface` is `terminal`, `desktop`, or `vscode`.

| Site | `e.props` | Terminal | Desktop | VS Code |
|---|---|:-:|:-:|:-:|
| `Pane` | `title`, `isFocused`, `bodyColumns`, `placement`, `scroll`, `view` | yes | yes | yes |
| `AbovePrompt` | `hasSurvey`, `isWorking`, `maxRows`, `bodyColumns`, `scroll`, `view` | yes | yes | no |
| `UserMessage`, `AssistantMessage`, `ToolUse`, `ToolResult`, `ToolGroup`, `AskUserQuestion`, `Spinner` | per site | yes | yes | yes |
| `CommandOutput`, `SessionMode`, `PromptHint` | per site | yes | yes (`PromptHint` not raised in practice, #100116) | no |
| `ToolProgress`, `TurnDuration`, `InfoNotice` | per site | yes | no | no |

The GitHub d.ts (line 8312) says `AbovePrompt` is "Raised on the terminal surface only"; the docs
table, the CLI string at 391561, and the Desktop renderer at ION 4082 all say Desktop too. The
docs win; the GitHub copy is older than the installed build.

## 4. Limits that shape a drawing

From reference.md "Limits" and interface.md "Draw in the VS Code extension".

| Limit | Value |
|---|---|
| A hook's own time for one event (not time inside `next` or a mods API call, except `$.clock.sleep`) | 10 s; 50 ms for `prompt.edit` |
| A `.catch` handler | 1 s |
| All `session.end` hooks together | 1.5 s unless the SessionEnd hook budget is changed |
| `$.ui.invalidate('ui.render')` | 10 redraws a second, 30 in the terminal for the visible pane, the expanded band, and the hint line; sooner calls coalesce |
| `$.ui.toast` | 4 s default; classic renderer: a newer toast of yours replaces an older one; fullscreen: at most three drawn |
| A pane opened without the person asking | Placed from 144 columns, 110 after they opened it once |
| Text in one tree | First 100,000 characters drawn |
| Elements in one tree; nesting depth | 20,000; 32 levels below the root |
| `$.process.run` | 30 s default, 10 min at most; 4 MiB stdout and stderr each |
| `$.fs.read`, `$.fs.write` | 4 MiB |
| VS Code status line and toast | 200 characters or two rows; 500 characters |
| Desktop status line and toast | 32ch truncate (ION 4082); 240 characters (ION 4082). Not in the docs. |
| One `claude plugin test` test | 5 s unless `timeoutMs` is set |

## 5. Session payloads by host

`session.start` carries `{ cwd, surface, isInteractive }` (d.ts 9396-9411). `surface` is
"`terminal` under the REPL; null for a `-p` run or the SDK, which draw nowhere yet". Desktop
starts Claude Code with `--input-format stream-json`, so it is the SDK case: `surface: null,
isInteractive: false`, and Desktop still renders the `ui_status`, `ui_toast`, `ui_log` and band
messages the mod sends (brb `CHANGELOG.md` 0.3.1; brb `mods/badge/tests/badge.test.tsx:56-58`).

| Host | `session.start` payload | What draws |
|---|---|---|
| Terminal REPL | `{ surface: 'terminal', isInteractive: true, cwd }` | Everything in section 1 |
| Claude Desktop, Code tab | `{ surface: null, isInteractive: false, cwd }` | Band, status, toast, log, pane, the shared sites; not `notify`, `notice`, the placed row, `PromptHint` |
| `claude -p`, Agent SDK, cloud | `{ surface: null, isInteractive: false, cwd }` | Nothing; hooks still run; `$.ui.notify` answers `no-surface`; `$.ui.ask` rejects |
| VS Code extension 2.1.299+ | `e.surface` is `vscode` in `ui.render` | Pane, the shared sites; status and toasts stack above the prompt; no band |

`$.session.surfaces()` lists every surface the session draws on, `terminal` first, then the
remote ones as they attach; empty in a plain `-p` run (d.ts 2392-2402). `$.session.surface()` is
deprecated. A render hook reads `e.surface` per ask.

## 6. Official pages

- overview.md: what a mod is, where mods run (the table with `-p` and cloud), built-in mods
- create.md: the three files, `register(on, options)`, `claude plugin validate`, the generated
  `.claude-plugin/types/`, validation rules (`$.ns.method` spelled out, string-literal event
  names, relative imports), `--plugin-dir` hot reload
- interface.md: pane and band, `$.ui.resolve(e)`, elements, keys, hotkeys, the collapsed band,
  redraws and the throttle, `$.state` and `$.store`
- events.md: observe, rewrite, answer; matchers; tool.call and tool.check; `.catch`
- api.md: commands and tools, `$.clock`, status/toast/log/notify, refused calls after Stop,
  `-p` refusals
- test.md: `claude plugin test`, stubs, `mock.clock`, `$.ui.mount({ surface })`, `/clear`
- gallery.md: screenshots of each element in a terminal pane
- troubleshoot.md: `hook skipped`, `answered ui.render without next()`, the band shows `plugin
  panel hidden`, a toast that does not appear, the debug log (`--debug-file`)
- reference.md: files, events, methods, render sites, elements, limits, commands
