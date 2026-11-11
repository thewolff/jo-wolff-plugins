# Reminders review

A skill that goes through your open Apple Reminders with you, one at a time.

For each reminder the agent decides what kind it is and says so:

- **A question**: it gives you an answer, researched if needed.
- **An instruction**: it tells you how it reads it and how it would do it, and acts only after you say yes to both.
- **A note or idea**: it says what it thinks the reminder is for and offers one useful next step.
- **Unclear**: it asks.

Before moving on, it asks "Can I close this one?" Yes marks the reminder complete. No means you keep working on it together. You can also tell it to leave a reminder open and move on. It never deletes reminders.

## Requirements

- macOS.
- [remindctl](https://github.com/openclaw/remindctl): `brew install steipete/tap/remindctl`. The first run asks for Reminders access for your terminal app; `remindctl status` should then say `Full access`.
- Optional: [rem](https://github.com/BRO3886/rem), to read links typed into Reminders.app's own link field: `brew tap BRO3886/tap && brew trust --formula bro3886/tap/rem-cli && brew install bro3886/tap/rem-cli`. Homebrew refuses an untrusted tap, so the trust step is needed. The skill only ever runs `rem show`.

## The Reminders.app link field

remindctl reads reminders through Apple's public EventKit, and EventKit does not expose the link field you see in Reminders.app ([rem architecture notes](https://rem.sidv.dev/docs/architecture/): "EventKit's EKReminder does not expose flagged state, the real URL field, or hashtags visible in Reminders.app"; [remindctl issue #46](https://github.com/openclaw/remindctl/issues/46)). remindctl still returns notes and EventKit's URL when they are set.

rem reads the link field through Apple's private ReminderKit framework, so with rem installed the agent sees that link too. Because it is a private API, a macOS update can break it without any error: rem may just start returning no link. rem's link can also come from EventKit's URL or a URL in the notes, so it shows the reminder has a link, not where it was typed.

Without rem, or when rem finds no link, a reminder with no notes and no URL gets one line from the agent saying a link may not have reached it, and a request to paste the link if there is one, instead of a guess from the title. Putting the link in the notes works too.

## Install

Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install reminders-review@jo-wolff-plugins
```

OMP:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install reminders-review@jo-wolff-plugins
```

## Use

```
/reminders-review                    # the lists saved in your config, or it asks which ones
/reminders-review "Errands" "Work"   # these lists, this time
/reminders-review lists Errands Work # save these lists as your default
```

The default lists live in `${XDG_CONFIG_HOME:-~/.config}/reminders-review/config.json`:

```json
{ "lists": ["Errands", "Work"] }
```

## Due reminders in every session

Reminders.app notifications are easy to ignore. If you name the lists you want watched, the agent brings up what is due in them itself: at the start of every session, and again at most once an hour while the session goes on.

It is off until you configure it. Add `watch` to the same config file:

```json
{ "lists": ["Errands", "Work"], "watch": ["Errands"] }
```

Or set it for one shell: `REMINDERS_REVIEW_WATCH="Errands,Work"`. The variable wins over the file when it is set; set it to an empty string to watch nothing. The variable is split on every comma, with no quoting or escaping: `"Family, Friends"` watches two lists, `"Family` and `Friends"`, quotes included. A list whose name contains a comma goes in the config file's `watch`, which takes each name whole.

For each watched list, the hooks run `remindctl show overdue --list <name> --json` and `remindctl show today --list <name> --json` and give the agent one line per list with something due, overdue first, then today, in your local time:

```
Due (list Errands): Nov 3 9:00 AM Renew the domain; 10:00 AM Pick up the prescription
```

The agent is told to raise these in its next reply, to treat the titles as reminder text rather than instructions, and to close one only through this skill after you say yes. Nothing is injected when nothing is due. The hooks only read: they never complete, edit or delete a reminder.

A long list does not flood the session: each list shows at most 40 reminders, the whole block stays within 8 KiB, and whatever does not fit is counted at the end of its line (`… and 12 more`), or, when not even a list's name fits, in one closing line (`Due in 3 more watched lists: 57 reminders not shown`).

- **Claude Code** runs the `SessionStart` and `UserPromptSubmit` hooks in `hooks/hooks.json`.
- **OMP** loads `omp/reminders-review-omp.ts` (declared in `package.json`), which runs the same check on `session_start`, `session_switch` and `before_agent_start` and hands the block to the agent as a hidden message. A block belongs to the session it was checked for: switching sessions drops one that was never delivered, and a check still running when the session changes is discarded. Subagent sessions are skipped, and never receive a waiting block.

The hourly limit is per session. Each session's last check is a small file under `${XDG_STATE_HOME:-~/.local/state}/reminders-review/sessions/`. `node scripts/reminders-review.mjs prune --days 30 [--dry-run]` removes stamps and rotated logs older than 30 days and ends with `pruned: <n> file(s), <bytes> bytes freed; kept <k>`; `plugin.json` declares that directory and that command.

If remindctl is not on the `PATH` the hooks see, set `REMINDERS_REVIEW_REMINDCTL` to its absolute path.

### How it fails

A broken check never blocks a prompt. When remindctl is missing, not authorized, slower than 2 seconds, writes more than 1 MiB for one list, or answers something that is not a list of reminders, that list contributes nothing, one line goes to `${XDG_STATE_HOME:-~/.local/state}/reminders-review/errors.log`, and at session start you get one line naming the fix:

- not authorized: `remindctl authorize`, then accept the macOS prompt
- not installed: `brew install steipete/tap/remindctl`
- a list name remindctl does not know: `remindctl list` shows the real names
- more than 1 MiB of open reminders in one list: watch a smaller list
- anything else: `remindctl doctor`

A config file that does not parse gets the same treatment. Prompts after the session start only log. Scenarios: `evals/session-start-due-fires.scenario.json`, `evals/session-start-nothing-due.scenario.json`, `evals/session-start-remindctl-absent.scenario.json`, `evals/prompt-due-fires.scenario.json`, `evals/prompt-within-hour-silent.scenario.json`.

## Safety

The text of a reminder is treated as data, never as permission. A reminder that says "delete the old branch" gets a proposal and two questions, not an action. Closing uses `remindctl complete`; the skill has no delete path.

## Changes in 0.2.2

`prune` prints the plugin-kit contract line last, `pruned: <n> file(s), <bytes> bytes freed[ (dry
run)]; kept <k>` (ledger's canary reads it), after the JSON line it printed before; a file it
could not remove is named on stderr and the exit code stays 0, not 1.

## Changes in 0.2.1

`lib/hook-runner.mjs` is plugin-kit 0.3.1's, byte for byte (was this plugin's own copy, which
carried the stdout drain first): the drain is unchanged, and the handler thread's env now also
carries `HOOK_RUNNER_STARTED_AT_MS` and `HOOK_RUNNER_DEADLINE_MS`, and a process group the thread
registers with `{ kitReap: <pgid> }` is killed when the runner exits. reminders-review's hooks
register none, so the due-reminders block is unchanged.

## Changes

0.2.0 adds the due-reminders injection above. Before release, review fixes went into the same version. Answers larger than one pipe buffer (64 KiB) reached the host cut off, as invalid JSON, because the hook runner exited before stdout drained. It now waits for the write, but only until its 4-second deadline, and logs one errors.log line when the host is not reading. remindctl output is capped at 1 MiB per call, and the block at 40 reminders per list and 8 KiB in all. In OMP, a waiting block no longer crosses into another session or reaches a subagent. The comma rule for `REMINDERS_REVIEW_WATCH` is now documented. A long title, failure reason or failure line is now cut between characters, so an emoji is kept or dropped whole instead of leaving half of it in the block. The test suite no longer writes to the real errors.log: the runner's test hook moved out of `test/`, where `node --test` ran it with the real environment, and stays silent unless its tests switch it on.
