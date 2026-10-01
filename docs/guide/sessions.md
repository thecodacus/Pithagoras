# Sessions

A session is one conversation with pi, its own model and effort level, and the
folder it works in. It is the normal unit of work in the portal.

## Where a session works

**New** starts a chat in **Home**, the first agent's own directory; a chat in a
project works in that project's folder, and a chat with another agent in that
agent's home. See [Projects](/guide/projects) and [Agents](/guide/agents). The session is named after its
first message, and you can rename it.

Paths are validated server-side: a workspace must resolve inside the workspace
root, so a session cannot be pointed at the rest of the filesystem. Deleting a
session never deletes its folder.

## Giving it a task

Type and send. The request returns as soon as pi accepts the message — it does
not wait for the work to finish. Close the tab if you like.

While a run is in progress you can keep typing; further messages are queued.
**Stop** aborts the current run.

## The message box

What you have typed and not sent stays with its chat. Switching to another chat
gives you that chat's box, and coming back gives you yours again — it survives a
reload too, for as long as the tab is open. Nothing typed in one chat can be
sent from another by accident.

A message that does not go — the portal is unreachable, or refuses it — goes back
in the box, in front of anything typed since, with the reason shown above it.
Nothing is thrown away to be typed again.

### Pictures and files

Paste a screenshot into the box, drop pictures on it, or pick them with the
paperclip, and they wait above the words as thumbnails — the × takes one back
out. They go to the model with the message, up to eight of them, and a message
can be a picture alone. The sent message shows them; click one to open it
full size.

A photo straight off a phone is made smaller in the browser before it goes:
2048 pixels on its longer side, as a JPEG. Models scale anything bigger down on
their side anyway, so those pixels would only cost upload time and context. A
picture that already fits goes as it is, and a GIF always does. PNG, JPEG, GIF
and WebP are taken; each must be under 5 MB once made ready.

If the model cannot see pictures, pi leaves them out and tells it one was there,
and the chat says so in a line above the answer — pick a model that takes images
and **Retry**. Whether a model takes them is the `input` of its entry in
`models.json` (`["text", "image"]`).

Anything that is not a picture — a PDF, a spreadsheet, a zip — is put in the
chat's folder instead, and the box gets a line naming it, so the agent knows to
look. A name that is taken there gets a number (`report (2).pdf`); nothing is
replaced. The agent has the tools for those files; the model on its own does not.

Pictures waiting in the box stay with their chat like the words do, but only
while the page is open: they are not kept across a reload.

Two keys work from anywhere on the page:

| Key | Does |
| --- | --- |
| `/` | Jump to the message box with the command list open. Not while you are typing somewhere else, where it is a character. It is the [command character](/guide/commands#the-command-character), so it is another key if you chose one |
| `Esc` | In the message box, **stop the run**. Only when the box is empty — the moment the send button is a stop button — so it can never cost you words |

## Queued channel messages and questions

Channel messages wait for the current run to finish before applying a new
speaker or role. Pending notes are included when that queued turn starts and
are removed only after pi accepts the prompt. A failed startup leaves the
notes available for the next attempt.

When an extension asks a question, submitting a response closes the dialog only
after the server accepts it. If submission fails, the dialog stays open with an
error so you can retry or dismiss it. A timeout or cancellation resolves the
original question; it does not cancel a newer question that has replaced it.

## Sent messages

Hovering one of your messages gives it these actions:

- **Copy** puts the text on the clipboard (a message that is only pictures has none to copy). The agent's replies have the same
  button, once they are whole. It works over plain HTTP too, where browsers
  withhold the clipboard API, by falling back to the older way.
- **Retry**, on your last message, drops the agent's reply to it — a half-finished
  one after a Stop, say — and sends the same text again. It is editing without
  changing a word, so the agent's memory ends up as if the first attempt never
  happened rather than holding it and a second copy of the question. Pictures
  that went with it go again.
- **Send again**, on an older message, sends its text and pictures as a new
  message at the end. Retrying one of those would drop everything since. While a run is going
  it queues, like anything else you type.
- **Edit** rewrites the message in place. It replaces that message *and
  everything after it* — the agent's answers were to a question that is no
  longer the same one — and sends the new text, with the same pictures.
- **Delete** removes the message and the agent's answer to it, tool calls
  included, and leaves the rest of the conversation as it was.

Edit and delete change what the agent remembers, not just what the page shows:
pi's own record of the conversation is edited too, and the agent's next turn
reads the version without the message. They are unavailable while a run is in
progress, so stop it first.

They do not undo what the agent *did*. Files it changed, commands it ran and
messages it sent stay as they are; only the memory of having done them goes.

Some cases are refused rather than guessed at, with a message saying why. A
message that a compaction has already folded into its summary cannot be deleted
on its own, since the summary would go on describing it — edit it instead, which
drops the summary with everything after. A conversation with branches from pi's
`/tree` cannot be trimmed cleanly either. A message is only matched to the agent's
record by its exact text (or as a voice turn), never by a fragment of it. Nothing
is changed when this happens.

An edited message, or one sent again, keeps the version it replaced. Where there
are several, a small `‹ 2 / 3 ›` switch beside the message shows another one —
the message and what followed it at the time. Switching, like editing, is only
possible while nothing is running.

If an edit's replacement is refused — the model is unreachable, say — the
conversation is put back as it was, rather than left without the messages the
edit meant to replace.

## Drafts and what is running

What you have typed into a chat's box and not sent is kept per chat, so half a
message does not follow you into the next chat, and survives a reload of the
page (in the browser's session storage, so not a new browser). An extension that
asks for what is in the box is told it.

Above the box, a small tray lists what runs beside the conversation: subagents,
background jobs the agent left running, and the status lines extensions set.
Each opens its own window — see
[Subagents and background jobs](/guide/extensions#subagents-and-background-jobs).
A status that names one of the chat's slash commands runs it when clicked.

## Sidebar and the sessions page

The sidebar opens with New, then the places — Sessions, Projects, Agent,
Routines and [Audit](#audit), with Browser and Memory added while the
[browser](/guide/browser) is installed and [Understory](/guide/features#memory-understory)
holds the agent's memory — then **Pinned**, then **Recents**. The button at its
top edge folds it to a rail of icons; under each chat's title it shows the folder it works in. Recents is capped at twelve; anything past that is reachable from
the Sessions page, which lists everything with search over names and workspace
paths.

Pinning is stored server-side and drives the ordering (`pinned DESC,
updated_at DESC`), so the sidebar and the Sessions page never disagree.

With more chats than the sidebar lists, it has a search field above them. It looks
through every chat by name and folder, not only the ones shown, and Escape clears
it. The Sessions page has the same search with more room.

### By folder

Once there is a project, the chats below **Pinned** are gathered by the folder
they work in: each agent's home, named after the agent, and each project, a
chat in a project's subfolder counting as the project's. Each folder opens to show its chats — the sidebar up to eight,
then *N more in …*, which opens the Sessions page at that folder — and remembers
whether it was left open. The folder of the chat you open is opened for you. A
project without chats is there all the same, and the **+** on a folder's line
starts a chat in it. A project folder made or removed outside the portal — by
the agent, say — shows up or goes within half a minute.

The Sessions page lists them the same way, every folder open to begin with, and
the funnel on a folder's line shows that folder on its own (`/sessions?folder=…`,
so the link keeps it); the ✕ on the chip goes back to all of them. A link to a
folder that is gone since says so. A folder's count, and the mark that something
in it is running, take in its pinned chats too, in the sidebar as on the page.

Folders are ordered **Latest first** (by their latest chat), **By name** (the
first agent first, then the other agents), or in **Your order**: drag a folder by its grip, or press Alt with ↑/↓ on
its name, and the order is yours from then on. The list button next to the order
puts the chats back into one list, Pinned then Recents, as before. The order,
the grouping and which folders are open are kept per browser, and the sidebar
and the Sessions page share the first two. Searching shows only the folders with
a match, open; one shut during a search is shut only until the search ends.

The chat's name at the top of the conversation renames it too: click it.
A name is at most 120 characters, wherever it is given — `/name` included.

Hovering a session gives you pin, rename and delete. Renaming turns the name into
a field where it stands — Enter or clicking away keeps the new one, Escape puts
the old one back — and double-clicking the name does the same. Delete asks in the
portal's own dialog, with the button saying what it will do — and **Settings →
General → Confirmations** turns that question off, for chats, messages, files,
skills, routines, projects, voices and channels alike. It is kept per browser.
Discarding unsaved changes is still asked about. The Agent tab's conversations
can be renamed and deleted the same way, from the row.

## Using a phone

Tap the navigation icon in the header to open the sidebar, then choose a
session or **New** to start a chat. Selecting an item closes the drawer;
you can also close it with its close button or by tapping the dimmed backdrop.

Use the send arrow beside the composer to submit a message. The keyboard's
Return key can still insert a new line. Long slash-command lists scroll inside
the picker, keeping the composer and navigation in view.

## Model and effort

The pills under the composer show the session's live model and effort level.
Both are per-session, both persist across restarts, and both fall back to the
portal default when unset — see
[Settings](/guide/settings#where-a-model-comes-from).

The model pill lists models you have used recently, with the full catalogue
behind **More models**. Only models with working credentials appear.

Effort is a slider over the levels the current model offers, from `off` through
`max` at most. A model can narrow that list with a `thinkingLevelMap` in pi's
`models.json`, and the pill follows it: a model with just `off` and one other
level turns the pill into an on/off switch, and one with a single level shows it
without a control.

pi coerces the level on a model that does not reason — ask for `high` on a
non-reasoning model and it lands on `off`. What gets stored is the level pi
resolved to, not the one you asked for, so a rejected value is not reapplied on
every restart.

### When `off` does not switch thinking off

The pill can say `off` and the model go on thinking. What `off` puts in the
request is decided by pi from the model's entry in `models.json`, and for an
OpenAI-compatible server it does not know how to switch reasoning off unless it
is told. Left alone it sends `reasoning_effort: "off"`, which llama.cpp does not
read: measured on a Qwen-family model, that answer reasons exactly as much as
`medium` does.

Those models switch thinking through their chat template, so say so:

```json
{
  "id": "Ornith1.5-35b",
  "reasoning": true,
  "thinkingLevelMap": { "off": "off", "minimal": null, "low": null, "medium": "medium", "high": null, "xhigh": null, "max": null },
  "compat": { "thinkingFormat": "qwen-chat-template" }
}
```

pi then sends `chat_template_kwargs: { "enable_thinking": false }` for `off` and
`true` for any other level — the request above went from 67 tokens to 4. A model
with `"off": null` in its `thinkingLevelMap` has no off at all and the pill does
not offer one; give it `"off": "off"` and the `compat` line to add it.

## Context

The rightmost pill is a donut showing how full the context window is, green
through amber to red as it fills. It follows a run turn by turn rather than
waiting for it to finish. Clicking it opens everything context-related:

- the exact usage — tokens used, window size, tokens left
- the **context window**, which you can change (below)
- **auto-compact**, on by default, which summarises before the window fills
- **compact now**, to do it immediately
- input and output tokens, message count, tool calls, cost

pi refuses to compact a session that is too short, and says so rather than
failing quietly.

### The context window

The percentage, and the moment a chat is compacted, are measured against the
window in the model's entry in `models.json`. That number cannot know how the
server is run. llama.cpp with `--parallel 2` splits `ctx-size` between two
slots, so a chat gets half of what the model's entry says: it is compacted far
too late and then fails at the server.

Set what one chat really holds in the pill's **Context window** field; **Reset**
goes back to the default (below) or, without one, the model's own number. The
setting belongs to the model, not the chat: it applies to every chat that uses
that model, open ones included, and is kept in the portal's database —
`models.json` is left alone. The pill appears once something has been said in a chat, and not before: an
empty conversation has nothing to measure, and a meter reading 0% is not
information. Until then the window is the one in the model's entry, or the
default below.

For all models at once there is a **Context window** default under
Settings → General. It is a ceiling: a model that declares more is held to it, a
model that declares less keeps its own number, and a window set for one model in
its pill wins over it. Leave it empty to use what each model says.

Neither is available with `EXECUTOR=container`. pi runs inside the container
there and the portal cannot change its model, so the field and the default are
turned off rather than accepting a number that would do nothing.

## Persistence

Sessions survive restarts. Three things make that true, and each was a bug
before it was a feature:

- **The conversation.** pi's session file path is stored on the session row and
  reopened by path. Earlier the portal called `SessionManager.create()` on every
  boot, which started a fresh conversation each time and reset context to 0%.
- **The model and effort.** Stored per session, applied when pi relaunches.
- **The transcript.** Independent of pi — every event is in the portal's own
  log, which is what replay reads.

If the server restarts mid-run, that session is marked `interrupted` rather than
left spinning. Send a message to carry on.

## The tab

The browser tab's title follows the chat you have open: `● Fix login · working`
while it runs, `❓ Fix login · asks you` while an extension is waiting for an
answer, and the plain name when it is done. Whether it is worth switching back
to is then readable from the tab strip.

The pages that refresh themselves — the sessions in the sidebar, Agent, Routines,
Channels, Browser, Audit — do that only while the page is visible, and once at
once when you come back to it. A tab left in the background asks for nothing.

If the connection to a chat breaks, the page reconnects — after two seconds,
then four, eight and at most fifteen — and says so once a second attempt has
failed. It is not shown for a blip.

## Status dots

| Colour | Meaning |
| --- | --- |
| Pulsing cyan | Running |
| Grey | Idle |
| Amber | Interrupted — the server restarted mid-run |
| Red | Error; the message is in the transcript |

## Audit

**Audit** in the sidebar is the guard's record of what it decided, newest first,
kept for the last 2,000 decisions. Each row says what happened, for whom, when
and, for a tool, which tool and what it was asked to do:

| Kind | Meaning |
| --- | --- |
| Refused | The agent was stopped from doing something |
| Allowed by rule | A [standing rule](/people/rules) let it through |
| Allowed by approval | Somebody [approved it](/people/approvals) |
| Turned away | A stranger on a channel was refused |
| You answered | A question from the agent was answered |
| Page opened | The agent's [browser](/guide/browser) was pointed at a page |

The buttons above the list filter it: **Everything**, **Refused**, **Allowed**
(both kinds) or **Strangers**, with counts of each and how many are shown. The
page shows the latest 300 and refreshes every ten seconds while it is visible.
Who is named is who they are called now: renaming a person renames them through
the history. There is no button to clear it.
