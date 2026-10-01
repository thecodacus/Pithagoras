# Agents

An agent is a character with a memory: a home folder holding its `SOUL.md`
(who it is), `PrimaryUser.md` (who it works for) and `MEMORY.md` (what it has
learned). A chat started in an agent's home talks to that agent, with those
files as its context.

The portal starts with one, the **first agent**, whose home is `AGENT_HOME`.
You can add as many more as you like, each with its own character, memory and
files.

## Making one

The **Agents** page shows a card for each agent, with its avatar and name and
how many chats it has. **New agent** asks the same two questions as the first
setup: who it is, and who it works for. Its home is made in `agents/` beside the
first agent's home, named after it (`agents/research-bot` for *Research Bot*),
and its files are written there.

A card opens that agent (`/agents?agent=research-bot`): its conversations, its
files to edit, and **New conversation** to start one with it. Its avatar is at
the top beside its name; the palette on it opens the avatar customizer. Each
agent's avatar is its own, and voice mode shows the avatar of the agent the
chat is with (the first agent's for a chat in a project). Its
name, with the pencil beside it, renames it; the folder keeps its name.
**Agents** at the top goes back to the cards.

## Its voice

With the voice add-on installed, an agent's page has a **Voice** menu: the
voice it speaks with in voice mode. **As in the voice settings** follows the
voice chosen in Settings; a designed voice or one from the voice library is the
agent's own. **Add voice** at the end of the menu adds a voice to the library,
a clone from a recording or one designed from a description, and gives it to
the agent. A library voice that is deleted is no longer any agent's, and those
that had it speak as the voice settings say again.

## In the sidebar

Each agent's home is a folder in the sidebar and on the Sessions page, named
after the agent. The first agent's has the house icon, the others a robot. The
**+** on a folder's line starts a chat with that agent. A conversation started on the Agents page
is listed there too; conversations that came through a channel are on the Agents
page only.

## Channels and routines

A channel talks as one agent: the first, unless you choose another under
**Talks as** in the channel's settings. Its conversations happen in that
agent's home, with its character and memory. Moved to another agent, a channel
starts new conversations there; moved back, it picks up the ones it had.

A routine can run in any agent's home: choose the agent under **Runs in**.

## Deleting one

The bin next to an agent's name deletes it. Its chats are stopped and deleted
with it, and its routines are switched off. It asks what to do with its folder:

- **Keep its folder**: its files and memory stay. Make an agent with the same
  name and it picks them up again.
- **Delete its folder too**: the folder and everything in it are removed.

The first agent cannot be deleted, only renamed. An agent a channel talks as
cannot be deleted until the channel is given another.

## Its name

The first agent is named after the heading in its `SOUL.md` when the portal
first starts with agents. Renaming any agent changes only what the portal calls
it; edit its `SOUL.md` to change what it calls itself.
