# Opt-in features

Two capabilities ship with Pithagoras and are **off** until you switch them on
in **Settings → Add-ons**: a **subagent tool** and **Understory** as the agent's
memory. A fresh install has neither. (The same tab holds the Docker-based
[Browser and Voice](/guide/add-ons).) Switching one on writes it into pi's own
configuration — a package, an MCP server — so it can also be seen, and undone,
from Settings → Extensions and Settings → MCP. Switching it off removes it.

Each is a reference implementation behind a seam the portal already has, so a
third-party equivalent can take its place without changing the portal:

- the subagent tool speaks the [subagent protocol](/guide/extensions#the-subagent-protocol);
  any extension that does is shown and steered the same way;
- Understory is an [MCP server](/guide/mcp); any memory server can be attached
  the same way.

A switch reloads the idle open chats so they have the change at once. A chat
that is busy — running, compacting, or with a subagent still working in the
background — keeps what it had until it is idle and reloaded (`/reload`).

## Subagents

**Settings → Add-ons → Subagents.** The `subagent` tool hands a self-contained
task to a second pi with a context of its own and gets its answer back. You can
watch it beside the chat (the robot button in the chat's header), give it
instructions while it works, and stop it.

Switching it on installs the bundled `extensions/subagent` folder as a local pi
package; switching it off removes it. One you installed by hand from a clone is
recognised as the same tool.

### How it runs against the agent

| Mode | What happens | When to use it |
| --- | --- | --- |
| **Interrupt** (default) | The tool call waits for the subagent's answer, so the agent's turn is held while it runs. Subagents asked for together run one after the other. | Local hosting, a single GPU: only one model call at a time. |
| **Background** | The tool call returns at once and the agent goes on working. The subagent's answer arrives later as a message in the chat and starts a turn if the agent is idle. A subagent you stop does not start one. | Hosted models, or hardware that can serve two agents at once. |

Background runs two agents — two model processes — at the same time. With a
local model that means two model calls at once, which a single GPU may not
hold. Stopping the chat does not stop a background subagent; stop it from its
window. Closing or reloading the chat does.

### Which model a subagent runs on

By default a subagent runs on **the model its chat is on** when it starts one —
the one already loaded, so a local server does not have to load a second one.
**Model** on the Subagents tab names another for every chat instead, and each
chat can say its own in its model menu (*Subagents in this chat run on*):
the default, this chat's model, or any model there is. A choice is read when a
subagent starts, so it needs no restart.

Stored as `subagentModel` in pi's `settings.json` (`"provider/model"`, or
absent for the chat's own); a chat's own is the portal's, and reaches the tool
over the protocol's `subagent:v1:config`.

### Subagents at once

**Subagents at once** (default 1) is how many run at the same time, across
every chat — each one is a model running. One asked for beyond it waits for a
free slot: in interrupt mode its tool call waits (and gives up if the chat is
stopped meanwhile); in the background the call returns saying it is queued,
and it starts once another has finished. A queued one does not start once its
chat has been closed or reloaded.

Both choices are stored in pi's `settings.json` — `subagentMode`
(`"background"`, or absent for interrupt) and `subagentMaxParallel` (absent
for 1, at most 16) — so the tool behaves the same when pi runs outside the
portal. `PI_SUBAGENT_BIN` picks the `pi` it starts (default: `pi` on `PATH`).

Subagents need the host executor (`EXECUTOR=host`): only there does the portal
share pi's event bus with the tool.

## Memory: Understory

**Settings → Add-ons → Memory.** [Understory](https://github.com/thecodacus/understory)
is a memory that grows: plain markdown on disk, cross-linked and maintained,
which the agent looks things up in and adds to through its tools
(`understory_memory_query`, `…_add`, `…_update`, `…_status`, `…_maintain`).
The bundle is human-readable and git-diffable.

### Running it here

With Docker access (see [Docker add-ons](/guide/add-ons#docker-access)), the
portal runs Understory itself, in a container of its own (`pithagoras-understory`)
with its memory in a volume (`pithagoras_understory-memory`). In Settings → Add-ons → Memory:

- **The model that keeps the memory.** Understory uses a model to file, link
  and tidy notes. By default **the chat's model**: the one the chat calling its
  tool is on, already loaded, so writing with one model does not load another
  for the memory. Understory is pointed at the portal as its model server, with
  a key of its own, and the portal passes each request on to that chat's model,
  with its address and key. With no chat asking — tidying up at night — the one
  that asked last, and before any has, the default model for new chats. It
  takes a model with an OpenAI-compatible API (local servers, OpenRouter); for
  another, and when the portal serves its own TLS, give Understory one of its
  own: *a provider set up here* — one and one of its models, its address and
  key taken from the provider each time Understory starts — or *an address of
  its own*: the API address, a key (none needed for a local server), a model
  and the format (OpenAI-compatible or Anthropic). A saved key is never shown
  again; leave the field empty to keep it.
- **Tidying up.** How often Understory goes over the whole memory on its own —
  merging duplicates, linking orphans, splitting notes grown too long (its
  "dreaming"). One of three: **never** (the default); **at a time of day** —
  every day at, say, 03:00 when nobody is using the model, in the portal's
  time zone, started by the portal while Understory runs, with Understory's
  own timer left off; or **on an interval** — every hour, 6, 12 or 24 hours
  or week, Understory's own timer, which counts from when it starts, so
  saving begins the count anew. Never both. Each pass costs tokens, and does
  nothing when the memory is already tidy. **Tidy up now** runs a
  pass at once, and the last one's outcome is shown beside it.
- **Install and use as the agent's memory** pulls the image the first time,
  starts it, and switches it on as the memory. Then **Stop / Start**,
  **Remove** (the memory stays in its volume) and **Remove and forget the
  memory** (deletes the volume; asked first).

Understory reads its model and interval only when it starts, so **Save and
restart Understory** makes its container again with the new ones; the memory
is untouched. Understory has no way to be asked for a pass, so at a set time
the portal runs the very pass its timer runs, inside its container with its
own settings (`docker exec`). It runs on the host network, like the browser, so a model server
the portal reaches on `localhost` is reached the same way. It is given a token
of its own (`AUTH_TOKEN`), which the portal writes into the agent's MCP entry
and uses for the Memory page; nothing else can read the memory through it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNDERSTORY_PORT` | `3800` | The port the portal's Understory listens on. |
| `UNDERSTORY_VOLUME` | `pithagoras_understory-memory` | The volume that holds its memory. |

Without Docker access, or to keep running your own, see
[Running your own](#running-your-own).

### Reading the memory

While Understory is on, **Memory** appears in the sidebar. Its page is laid out
as Understory's own:

- down the side, the memory's folders and notes, each with its type, and
  Understory's own `index.md` and `log.md` set apart; a search; and whether the
  bundle is well-formed (*conformant*, or how many issues — which lists them);
- beside it, the open note — its type, tags, when it last changed, its text,
  and links to other notes that open them there — or the **Log** of changes,
  newest first, or the **Graph**: every note as a point coloured by its type,
  its links as lines, unlinked notes ringed in red, the paths Understory's own
  queries took, and zoom, drag and click to open.

What is open is in the address (`/memory?note=…`, `?view=log`,
`?view=graph`), so it can be linked to. Understory's chat is not there.

### Changing a note by hand

In the Understory the portal runs, a note can be **edited** — its title, type,
description, tags and text — or **deleted** (asked first), from the pencil and
bin over it. Understory's own index.md and log.md are its to write, and are
not offered. The change goes through Understory's own write path, run in its
container like the tidy-up, so its index and log follow it; Understory has no
API that writes. One run elsewhere is read only here.

A change by hand can leave something behind: a link to a deleted note, a note
nothing links to any more, an index that misses something. So after each one a
window says what Understory's checks find now, and offers the two ways to put
it right:

- **Rebuild the index** writes every folder's index.md anew and removes empty
  folders — no model, a moment.
- **Repair with the model** runs Understory's own pass over the memory (the
  tidy-up): it mends links, wires in notes nothing links to and merges what is
  doubled. It takes as long as the model needs, and costs tokens.

Or leave it; the nightly tidy-up, if set, gets to it as well. **Repair with
the model** is offered only when there is something to repair, and the model is
not asked otherwise; the tidy-up the portal starts skips an empty memory too.

**Clear the log** (in the Log) empties the record of what changed and the
paths Understory's queries took; the notes stay. **Clear the memory** (the bin
beside the heading) starts the memory from nothing: every note and folder
deleted, the index and log as a new memory has them, and Understory started
again so it holds nothing of what was there. Both ask first, and cannot be
undone. (**Remove and forget the memory** in the add-on removes Understory as
well.)

The portal asks Understory for all of it, at the address in `mcp.json` and
with its token, so the page works wherever the portal does: over HTTPS, from a
phone, without Understory's port being reachable from the browser. It reads the
small JSON API Understory's own web UI uses (`/api/tree`, `/concept`,
`/search`, `/log`, `/graph`, `/traces`, `/validate`), which is not a
documented one: should a new Understory change it, the page says what went
wrong instead of showing an empty memory.

### Switching it on and off

Switching it on:

1. installs `pi-mcp-adapter` if it is not installed yet, which makes MCP servers
   into tools;
2. writes an `understory` server into `mcp.json`, with its tools directly in the
   agent's tool list — the portal's own Understory with its token, or the
   address given;
3. stops reading `MEMORY.md`.

Switching it off removes the server, and `MEMORY.md` is read again. Removing
the portal's own Understory switches it off too.

### MEMORY.md while it is on

Understory **replaces** the agent's global memory, so the two do not both feed
the agent: while the `understory` server is in `mcp.json` and not disabled,
`MEMORY.md` in the agent's home is not handed to new chats, and the agent is
told to use its memory tools instead. The file is not deleted, and it is marked
as not read on the Agents page. Disabling the server in Settings → MCP counts as
off too.

Only conversations with the primary user ever had `MEMORY.md`; a teammate's
conversation cannot use the memory tools unless a rule allows it (see
[Roles](/people/roles)).

### Running your own

Understory can also run anywhere the portal reaches, set up by you; the portal
then only points the agent at its MCP address (*Or use one you run yourself*
in the Memory add-on). Its model and tidying up are then set in its own
environment — `LLM_*` and `DREAM_INTERVAL`, which the portal cannot change.

```yaml
services:
  understory:
    image: ghcr.io/thecodacus/understory:latest
    ports: ["3800:3800"]
    volumes: [understory-memory:/bundle]
    environment:
      BUNDLE_ROOT: /bundle
      LLM_API_BASE_URL: ${LLM_API_BASE_URL}
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_API_FORMAT: openai
      LLM_MODEL: ${LLM_MODEL}
      # DREAM_INTERVAL: 6h
      # AUTH_TOKEN: ${MEMORY_UNDERSTORY_AUTH_TOKEN}
    restart: unless-stopped
volumes:
  understory-memory:
```

The address is what the **portal** reaches: `http://localhost:3800/mcp` with
the shipped compose file's host networking, or `http://understory:3800/mcp` on
a shared Docker network. It can be changed in the Memory add-on.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_UNDERSTORY_URL` | `http://localhost:3800/mcp` | The address the Memory add-on starts from. |
| `MEMORY_UNDERSTORY_AUTH_TOKEN` | — | Sent as `Authorization: Bearer …` when Understory has an `AUTH_TOKEN`. Named in `mcp.json` (`bearerTokenEnv`), never copied into it. |
