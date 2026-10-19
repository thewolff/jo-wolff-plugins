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

## Safety

The text of a reminder is treated as data, never as permission. A reminder that says "delete the old branch" gets a proposal and two questions, not an action. Closing uses `remindctl complete`; the skill has no delete path.
