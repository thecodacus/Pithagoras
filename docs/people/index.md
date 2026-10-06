# People

The agent can work with your team without treating everyone as its owner. This
section is how that is decided: who it will talk to, what each of them can get
it to do, and what happens when somebody needs more than they have.

- [Roles](/people/roles) — the four levels, and what each can see
- [Approvals](/people/approvals) — when a colleague needs your say-so
- [Allowed anyway](/people/rules) — standing permissions, and how narrow they are
- [Group chats](/people/groups) — one conversation, many senders
- [Trust and its limits](/people/trust) — what identity is worth, and what is not covered

## The roster

Settings → **People** lists everyone who has ever messaged a channel, including
the ones the agent turned away — that is what the list is for. Somebody appears
the first time they write, whether or not they got through.

Rows are a name, a role and a chevron. Everything else lives on their page.

## How somebody is identified

By the platform's own id — a Telegram user id, a Slack user id — scoped by
channel, so `telegram:100200300` and `slack:U04AB` never collide. Never by a
display name, which is whatever the sender set it to this morning.

One person may reach the agent on several channels. Each identity is its own
row, because each is a separate claim the platform is vouching for.

## Strangers

A sender nobody has classified is refused **before a session exists**, so there
is nothing for them to talk the agent into:

> I only talk to people I have been introduced to. I have let my primary user
> know you got in touch — if they add you, try again.

You are told once, not once per attempt, in the chat your routine reports go to
(Settings → Defaults → Routine reports). That message is the portal's, not something the agent said:
it is not added to that conversation as a note, so a stranger writing to the bot
cannot make your own chat refuse a routine or a push. Their id is recorded so you
can promote them from the list rather than going to find it on the platform.

With no report chat set, or when the message could not be sent, nobody was told,
and the stranger is told so instead:

> I only talk to people I have been introduced to, and I could not reach my
> primary user about you. Ask them to add you, then try again.

Their next message tries again, so setting a report chat later still brings the
word.

::: tip The gate opens itself until you name a primary
With nobody marked primary, the portal has no basis for deciding who is a
stranger, so it lets everyone through and simply records them. Name yourself
primary and the gate closes. This is also why turning this on in an existing
deployment does not lock you out of your own agent.

It also means the other way round: take the role from your only primary user, or
forget them, and the gate is open again. The portal asks before you do.
:::

## Forgetting somebody

**Forget** asks first, then removes the row. It is not a block — the next message from them
arrives as a stranger, is refused, and they reappear here. Blocking is what the
**Blocked** role already does.
