# Trust and its limits

What the roster is actually asserting, and where it stops.

## Identity is the platform's, not ours

| Channel | Sender id | Worth |
| --- | --- | --- |
| Telegram | `message.from.id` | Solid — the platform vouches for it |
| Slack | `event.user` | Solid |
| Discord | `message.author.id` | Solid |
| Webhook | whatever the caller sent | Only as good as the secret |

Display names are never used to tell people apart. They are chosen by whoever is
typing, so they are cleaned (one line, no angle brackets, at most 64
characters) before they reach the agent or a request to you, and one you set
yourself on the person's page is not replaced by a new one from the platform.

::: warning A webhook's sender is a claim, not a fact
The secret authenticates the **caller**, not the person it says it is speaking
for. Anything holding it can claim to be anyone.

Set **Sender id** on the channel and every message is pinned to one person — the
secret becomes that person's credential and the body cannot override it. Leave
it blank only when a trusted service is relaying many people.
:::

A message that names **nobody** is not the owner's either. Once a primary user is
named, a channel message without a sender id is turned away like a stranger's
(and recorded in the audit log), and a conversation begun that way is read as a
guest's. A channel package has to say who sent each message; see
[writing a channel](/channels/writing-a-channel#identity). Conversations you
start in the portal itself, on the Agent page or in a chat, are yours: nobody is
named in them, because you are signed in.

## What the guard covers

Roles decide what somebody may ask for. The [guard](/guide/security) decides
what actually runs, and it does not take the agent's word for who is speaking:
if no speaker has been identified, it falls back to the conversation's own role
rather than assuming the owner.

That default matters more than it sounds. A message sent through the portal's
own chat box into a colleague's conversation identifies nobody — and reading it
as "the owner is typing" once let a colleague's conversation run with full
privileges.

## What is not covered

- **Somebody influencing what you ask for.** See [group chats](/people/groups).
- **Anything after code execution.** The container has unrestricted outbound
  network, so a command that runs can talk to anywhere.
- **A person's own account being taken over.** The portal trusts the platform's
  identity; if their Telegram account is compromised, so is their role here.

## Revoking in a hurry

Set their role to **Blocked**. It takes effect on their next message — there is
no session to tear down, because the check happens before one exists.

To remove a standing permission without changing their role, delete the rule on
their page.
