# Devices

A **device** is one of your own computers, paired with the portal through the
**Pithagoras Sync** client that runs on it. A chat you give a device to can
read and change files there and run commands, as far as the device's own
settings let it. The settings live on the device, not in the portal: the
portal can see them, and change them only where the device's owner allowed
that on the device.

Devices are an add-on, **off** in a fresh install. While it is off, nothing
about devices answers: no device can pair or connect, and paired ones wait
until it is on again. The pairing and connection addresses then answer
"Devices are not available on this portal" to anybody, whether the add-on is off
or the portal lost its password, so that they tell an outsider nothing about
the portal; the reason is on Settings and the Devices page, for you.

## Switching it on

**Settings → Add-ons → Devices.** The add-on needs a portal password: a portal
that runs without one (`PORTAL_ALLOW_NO_PASSWORD`) cannot switch it on, as a
paired computer would be open to anyone who reaches the portal. The password is
checked each time the portal starts, not only when the switch is turned: a
portal that is restarted without its password treats Devices as off, whatever
the switch says. Nothing pairs or connects, and Settings and the Devices page
say why. The devices stay paired, and the add-on is on again once the password
is. Once it is on, **Devices** is in the sidebar.

A reverse proxy that asks for its own login in front of the portal stops a
computer from pairing: its requests to `/sync/v1/pair` and `/sync/v1/connect`
would be sent to the proxy's login page. Until proxies are supported, let the
portal's password be the login and let the proxy pass the portal on.

Switching it off closes every device's connection and cancels an open pairing
code. The devices stay paired, and connect again by themselves once it is on.

## Pairing a computer

1. Install the client on the computer: the **Devices** page links to the
   newest release for Linux and Windows (the client's README has the rest).
   Run it as the user whose files the chats should reach, or better as a user
   of its own.
2. On the **Devices** page, press **Pair a device**. The portal shows an
   eight-character code, good once, for ten minutes. Ten wrong codes, from
   anywhere, cancel it.
3. Copy the command under the code and run it on the computer:

   ```sh
   pithagoras-sync pair 'pithagoras-sync://pair?portal=https%3A%2F%2Fportal.example&code=K7Q2M9XZ'
   ```

The link carries the portal's address as the page was opened, so open the
portal at the address the computer reaches it at. The client talks to the
portal only over HTTPS, or plain HTTP to an address on its own machine
(loopback). When the portal serves HTTPS itself (`PORTAL_TLS_CERT`, `PORTAL_TLS_KEY`) and the
page was opened over HTTPS, the link also carries the certificate's pin
(`spki=`), so a self-signed certificate works and no other one does. Behind a
TLS proxy there is no pin, and the computer checks the proxy's certificate
against its system's certificate authorities.

The code is shown only on the page that made it. Reloading the page says a
code is open, and until when; make a new one to see one again. A new code
replaces the old one.

The device asks for a name (by default its host name). When the name is
already taken, it gets a number (`laptop-2`): a computer that is paired again
after `pithagoras-sync unpair` is a new device to the portal, and the old entry
can be removed.

## The list

Each device shows whether it is **connected**, or when it was last seen; its
system and the user the client runs as; the client's version; its **mode**:

- **Ask**: every call asks you first.
- **Folders**: only in the folders the device grants, with commands only where
  a folder allows them.
- **Full**: everything the client's user can do, with the device's protections
  (protected paths, risky commands, untrusted chats) still asking.

and the tools it offers. A device that is the portal's own machine and user is
marked as such: a chat reaches nothing there that the portal's own tools do
not, so it is not offered to chats.

**Rename** with the pencil. **Remove** with the bin: the device's token stops
working, its connection is closed at once, and every chat loses it. To use the
computer again, pair it again.

Under a connected device, **Connected from** shows the address and the client's
name for itself that the portal saw. Behind a reverse proxy the address is the
proxy's.

A device has one connection at a time. When something else connects with its
token, the portal pings the connection it has. Anything it sends in the next
few seconds counts as a sign of life, not only its answer to the ping, as a
device that is busy writing a command's output answers late. A laptop that slept
or changed network says nothing, so its next connection replaces the old one.
When the old one is alive, the new one is refused and the device shows a
warning with where each came from. The warning is shown too when the old one was
replaced but had been heard from within the 45 seconds before: a laptop that
slept is hardly ever that fresh, a copied token that answers slowly is. If one
of them is not yours (a second copy of the client, a copied token), remove the
device and pair it again.

## Giving a chat a device

A chat reaches no device until you give it one. In the chat's header, beside
the browser's globe, the **laptop** button lists the paired devices, each with
a dot that says whether it is connected:

- The switch gives the chat that device, or takes it back. Only a connected
  device can be given, and not the portal's own machine.
- The folder under it is where the chat starts on the device: relative paths
  and commands begin there. It starts as the device's home, or in **Folders**
  mode as its first folder; type another, or pick one of the device's folders.
  In Folders mode only a folder the device offers is taken.

Each chat has its own devices, and a new chat has none. The button is only in
chats of the portal itself: a chat on a channel (Telegram, say) cannot answer a
device's questions, so it gets none. A chat that is working takes a change up
once its current run is over.

### What the agent can do there

Once a chat has a device, the agent's `read`, `write`, `edit` and `bash` take a
`device`: with it they act on that computer, without it on the server, as
before. `grep`, `find` and `ls` act only on a device. The agent is told which
devices the chat has and their folders; a call on a device shows the device's
name on its card in the chat.

- `~` is the device's home, and a relative path starts in the chat's folder
  there. On Windows, `C:\Users\x` is written `/c/Users/x`; the agent may use
  either.
- `bash` runs the device's own shell, in the device's own environment: nothing
  of the portal's environment goes along, and the command is the one the model
  wrote: what an installed extension rewrites in the portal's `bash` commands
  (a prefix such as `rtk`, which only the portal may have) is not applied to
  it. So a rewrite that another extension makes to be safer (`rm -r` turned
  into a trash command, a `timeout` in front) does not reach devices either:
  what protects a device is its own settings. (When a provider gives several
  calls of one message the same id, the portal cannot tell which is which, and
  runs each call's command as it came out of the extensions.) The agent sees
  the end of a long output (the last 2000 lines or 50 KB, as on the server);
  the full output is not kept, so to see more it runs the command again,
  narrowed.
- `edit` writes back only if the file did not change on the device since it
  was read; otherwise the agent is told to read it again.
- Nothing falls back to the server: a device the chat does not have, one that
  is not connected, or one that switched a tool off is an error that names the
  devices the chat has.

Other tools, subagents, background jobs and MCP tools always act on the server.
A call of another tool that names a device is refused, rather than run on the
server where a device was meant, and so is any call on a device for somebody who
is not the primary user (a colleague in a shared conversation): the computers are
yours. A tool that has a `device` parameter of its own, a smart-home tool's for
one, means something else by it and is left alone, with Devices on or off. With
Devices off, only pi's own `read`, `write`, `edit`, `bash`, `grep`, `find` and
`ls` are still refused when they are given a `device`.

When the last device is taken back, the tools stay as they are for the rest of
the chat's session and refuse a `device`; `grep`, `find` and `ls` go away
again. When the chat is deleted, or the device removed, the grant ends too, and
a device that is connected forgets what it allowed the chat. One that is not
connected (asleep, say, or removed and paired again later) hears of it when the
chat is next given it: the portal tells it, makes the grant only once the device
has answered something after that, and so what it allowed the chat before never
comes back. A device whose connection has gone quiet without the portal noticing
yet, a laptop that has just gone to sleep or lost its network, does not answer:
the chat is not given it (the answer says so), and trying again a moment later
works. A grant that is switched off again, or whose chat or device is deleted,
while it waits for that answer is not made.

Ending a grant also stops what the chat is doing on the device. A command that
is running is told to stop (and killed ten seconds later if it does not), the
chat's call ends with an error that says the device was taken back, a question
it waits on is withdrawn, and any other question the device still holds for that
chat is denied, however many calls the device has open (denials and stops are
not held back by that limit). An **Allow** on the Devices page for a chat that
no longer has the device is refused and denies the question instead, so a page
that was open when the grant ended cannot run anything. A device that is
connected is told as well, and forgets what it allowed the chat; one that is
not is told when the chat is next given it (see above). This is the
portal's side: a command the device has already started may still do what it was
doing until the device stops it. A portal that does not do this at all is the
"compromised portal" under [What is trusted](#what-is-trusted).

If another installed extension brings a tool of one of these names, that chat
cannot be given a device, and the button says why, also under a device the chat
was given before the chat was loaded.

## Approvals

A call that the device holds for your answer is asked in the chat that made it,
as a card above the message box (the call itself says "Waiting for approval on
*device*…"), and shown under the device on the **Devices** page, with what it
wants to do and why the device asks. A chat that you open or reload while the
question waits shows the card again, and it goes as soon as the question is
answered anywhere, runs out, or its call ends. When several calls wait at once
(commands running in parallel, say), the chat shows only the oldest as a card,
with "Approval 1 of 3" above it and the others in a short list under it, which
opens with **Waiting next**. Each call is decided on its own, and the next one
moves up when the one in front is answered. On a phone the card takes the width
of the chat and its buttons wrap:

- **Allow once**: this call.
- **Allow for this chat**: this call and more of its kind from the same chat,
  for as long as the device's settings say. Offered only for Ask mode's own
  question.
- **Allow for** *n minutes*: the same, for a time; no longer than the device
  allows.
- **Deny**.

The command is shown as it is written: its line breaks stay, and a character
that would hide or reorder it (a control character, a zero-width character, a
right-to-left mark) is written out, as `\n` or `\u{202e}` in a highlight, the way
the client's own prompt does. One that is too long for the client (64 KiB) is
shown cut, says so, and can only be denied, here as on the device. A card's
buttons come on a moment (under a second) after it appears, so that a double
click, or a second click meant for the card before, does not answer the next
question. An answer is for the question it was shown for: when the device's
client has restarted, and numbers its questions from 1 again, an answer from a
card that has not refreshed yet is refused ("That question is not open any
more") and nothing is answered.

The first answer wins, from the chat, the Devices page or the device itself
(`pithagoras-sync approve 12`, `deny 12`). An approval that nobody answers is
denied when the device's time for it runs out (two minutes unless the device
says otherwise). Approvals are asked only in the portal and on the device: a
chat on a channel (Telegram, say) cannot answer one.

## Settings

Under each connected device, **Settings** shows the device's settings, as the
client's `portal_policy` allows:

- `off`: the portal sees nothing of them.
- `read` (the default): shown, not changed.
- `write`: the portal may change them. Settings open as a form, in the
  sections the client's settings have: mode and folders, Full mode, tools,
  what is refused everywhere, command rules, hours, protected paths,
  approvals, root and elevation, and running commands. Switches are
  checkboxes, choices are buttons, numbers are number fields, and the lists
  (folders, paths, rules) have a button to add an entry and one to remove it.
  A setting the document leaves out shows the device's default and is written
  only once you change it. **Save on the device** sends the whole document with
  the version it is based on: when the settings changed on the device
  meanwhile, the save is refused and nothing changes. The device checks every
  value, and refuses changes to the settings it lists as its own (**Only the
  device changes**): the form shows them, marked, and does not let you edit
  them.
- Under **Advanced (JSON)** the same draft is the whole document as text. It
  also holds settings the form has no control for, such as ones a newer client
  adds: the form passes them through as they are, so a change in the form never
  drops them. A change in the text shows in the form and the other way round.
  While the text is not valid JSON the form and **Save on the device** are off,
  and the text opens by itself so that it can be fixed. Where the portal may
  only read, the form and the text are shown and cannot be changed.

The shell, sudo's path and where the elevation password is kept are in the
document but are the device's own (**Only the device changes**): the portal
shows them and cannot change them. `portal_policy` itself, the client's
profile and the pairing are not in the document at all, and the elevation
password is no setting: it is typed on the device and never goes through the
portal. Only the device's owner changes any of these, on the device. The
client's settings are described in its `docs/permissions.md`. The portal keeps a device's settings only when they nest
at most 32 levels deep and take at most 256 KiB as text, which the client's own
never come near: a document past that is left out, and the portal goes on with
the ones it had. A device that does not share its settings (`policy` is not in
the capabilities it names) cannot change them either.

What a device decided about a call (allowed, asked, denied) is in the portal's
[audit log](/guide/sessions#audit) as **Device**, with the device's name. These
are the device's own word: the portal takes at most five a second from one
device (after a burst of fifty, however often it reconnects) and writes one
note with how many it left out, and keeps the newest 500 of the devices' entries
together, so that a device cannot push the portal's own entries, such as what
the guard refused, out of the log. A device that keeps sending still ages out
the others' entries at five a second; the devices keep their own logs.

## What is trusted

A device trusts the portal it is paired with. The portal is a server you run;
whoever controls it controls what it asks of every connected device, within
each device's own settings. In particular:

- **A compromised portal is the same as Full mode on an Ask device.** Approvals
  are answered in the portal, so whoever controls the portal can answer them.
  The protections that stay are the ones the device enforces itself: its mode's
  folders, its denied paths and command rules, its hours, the tools it has
  switched off, and the settings only it may change. A device that must not be
  reachable from a compromised portal should not be paired.
- **An agent's own shell on the server can reach the portal.** A chat's agent
  runs as the portal's user, with the portal's login password (and its secret,
  where one is set) in the environment of its server `bash`, and it can read and write the portal's own
  files and database. So a chat whose agent may run commands on the server can,
  in principle, log in to the portal's API, grant itself a device and answer the
  approvals that device sends, or change the device's settings where it lets the
  portal. This is the compromised portal above, reached from a chat: the portal
  does not shut it out in this version. What stays is again only what the device
  enforces itself (its mode's folders, denied paths and command rules, the tools
  it has switched off, and the settings only it may change). Keeping the answer
  to a risky approval on the device would close this, and is not there yet.
  Until then, do not pair a computer that the server's agent must not reach.
- **Without a grant, a chat's tools do not reach a device,** and only the chats
  you give one (but see the shell above): each call names the chat, and the device keeps what it allowed
  per chat. The device is also told whether the portal's guard saw the chat
  read something untrusted (see [Prompt injection](/guide/security)); it can
  only make the device more careful.
- **A device's folders and home are plain paths.** The portal refuses a path
  with a control character (a line break, for one) in what a device reports as
  its home or folders, and in a folder you pick for a chat, and quotes the
  folder where the chat's agent is told about it, so that a name cannot pose as
  an instruction.
- **The sudo password stays on the device.** Elevation (Linux `sudo`, off by
  default) uses a password stored on the device; it is never sent to the
  portal or the agent, and a command run with it always asks.
- **The connector token is the device's login.** The portal stores only its
  hash and compares it in constant time; the device keeps it in a file only its
  user can read. Removing the device makes it worthless at once.
- **The pairing code is the pairing's login.** Single use, ten minutes, ten
  wrong attempts in all. Pairing and the device's connection are refused from a
  browser (any request that names an `Origin`), so a web page cannot spend a
  code or open a device's connection.
- **One connection per device.** A second connection with the same token is
  refused while the first is up and showing signs of life, so a copied token
  cannot push the real device off; the attempt is shown on the Devices page, with
  the address and client name of both. A first connection that has gone quiet
  (the laptop slept) is replaced by the device's next one after a short ping. A
  token copied to another machine could take a quiet device's place the same
  way, so it is shown too when the old connection had been heard from in the
  45 seconds before, and the **Connected from** line is how to tell after a
  longer silence. Only one new connection per device is looked at at a time.
- Messages on the device's connection are limited to 4 MiB and file transfers
  to 64 MiB. A command's output is limited by the device (16 MiB by default)
  and, whatever the device does, by the portal: past 32 MiB the portal stops
  taking it and has the command killed, as the output also goes into a log file
  in the portal's temp folder while the command runs (the file is removed when
  it is over). A command that the device does not report as ended within its
  timeout and half a minute is killed and given up on. That timeout is the one
  the agent gave, and never longer than the device lets a command run: its own
  `exec.max_timeout_secs` (four hours by default), which the portal knows from
  the settings the device shares, and takes as four hours when it does not. So a
  device set to eight hours needs to share its settings for the portal to wait
  that long. A `timeout` that pi would refuse on the server (not above zero, or
  over 2,147,483 seconds) is refused for a device too. Nothing in a call carries
  environment variables to the device.
- The portal logs pairing and removal by device name only; tokens and codes
  never reach a log. When a device says it refused something the portal sent,
  the portal writes the first such message of a minute (quoted, cut at 200
  characters) and one line with how many more there were, however many it sends.
