# Routines

A routine is a standing instruction and a schedule. When it fires the agent is
given the instruction, does the work, and goes quiet again — nobody is waiting
on the other end, so a run may take as long as it takes.

Routines live in the sidebar next to Sessions and Agent. By default they run in the
agent's home directory and share the agent's memory; **Runs in** gives one a project
instead, and its runs work in that folder. Each place keeps its own session, so
moving a routine back picks up where it left off. If the folder is later removed,
the routine says so and its runs fail until another place is chosen.

## Scheduling

Either a five-field cron expression (`0 9 * * 1-5`) or one of the `@shorthands`,
**or** a single moment for a one-off. Never both — a routine that repeats and a
routine that happens once are different things, and the form says so rather than
guessing. As in cron, Sunday is `0` or `7`, and days and months can be written
by name: `30 8 * * mon-fri`, `0 9 1 jan *`.

**Run now** on a one-off whose moment is still to come is a try-out: the moment
stays, and it runs then as well. Giving a one-off that has already run a new
time switches it back on.

A one-off catches up: if its moment passed while the portal was down, it still
runs when the portal comes back. A recurring one does not — it simply waits for
its next slot, because ten missed hourly runs firing at once helps nobody.

By default a routine keeps one session, so a run can see what the last one did —
"nothing new since yesterday" needs yesterday. **Fresh session each run** gives
each one a clean start instead, for work where history is only noise.

## Reporting back

A run's closing account is stored, and stored is where it stays unless the
routine has somewhere to report. Give it one and the agent gets a `report` tool.

The agent decides **whether** a run is worth reporting and writes the message
itself. It does not decide **where** — that is configuration, so a routine
cannot start messaging somewhere it was never pointed at.

Two places to set it:

- **Settings → General → Routine reports** is the portal-wide default. Every
  routine inherits it, including one the agent creates for itself from a chat.
- **A routine's own page** overrides that: a different conversation, or *Never
  report* for one that should stay quiet whatever the default is.

A destination is a conversation that already exists — you pick "telegram —
Sam Rivera", not a chat id. Only channels that can start a conversation appear;
a webhook cannot, because it only ever answers a request that is already open.

A routine created from a chat reports back **into that chat** — asking for a
morning summary in Telegram means "tell me here". The portal-wide default
applies to routines created any other way, and to conversations whose channel
cannot be messaged out of the blue.

What a routine says into a conversation becomes part of it. Ask "what did you
mean by that?" the next morning and the agent knows what "that" was, because the
report is folded into the conversation's next turn rather than only being
delivered.

::: tip Silence is a result
The agent is told to skip the report when a run was uneventful. A report that
says nothing happened trains you to ignore the next one — and the next one might
be the one that mattered.
:::

## The injection guard

By default a run that reads something untrusted — logs pulled over the network,
a web page, mail — cannot then push, write onto `PATH`, upload data or read
credentials. That is the [guard](/guide/security), and for most routines it
never comes up.

It gets in the way of one honest shape of work: **read the logs, then fix what
they say**. Fetching the logs taints the session, and the fix is a push. Grepping
those logs for the word `token` looks like reading credentials. Nothing is
wrong, and the run stops anyway.

**Injection guard** on a routine's page turns the blocking off for that routine
alone. Two things stay:

- Untrusted content is still labelled as untrusted, so the agent knows what it
  is reading. That half never gets in the way.
- Anything it does that the rules would have stopped is recorded in **Audit** as
  `allowed-by-exemption`, with the rule that would have fired.

::: warning Turn it off for the routine, not the habit
The rules exist for when the log line was written by somebody who wanted the
agent to read it. Exempt the routine that needs it, leave the rest alone, and
read the audit occasionally.
:::

## Letting the agent manage them

Sessions reached through a channel get `routines_list`, `routine_create`,
`routine_update` and `routine_run`, so "remind me every morning to check the
backups" writes the routine instead of telling you where the button is.

Task sessions do not get them — a session working inside your repository has no
business rescheduling anything. Neither does a routine run: a routine that can
create routines can build a chain with nobody watching it.

There is no delete tool. Disabling stops a routine firing and leaves it visible,
so a misheard "cancel the morning thing" is recoverable. Deleting stays a
deliberate act in the UI.
