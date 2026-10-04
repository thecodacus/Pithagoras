# Sandbox

The [guard](/guide/security) reads what the agent asks for and refuses what
looks wrong: a path with `.secrets` in it, a command that pipes into a shell.
That stops the plain way to a file, not the roundabout one. A script the agent
writes and then runs, a path put together from pieces, or a symlink all ask for
something else, and each reaches the same file.

The sandbox closes those ways too. With it on, everything the agent does to the
system runs as an unprivileged user, `pi-agent`, and the operating system
decides each step by the files' own permissions. A script, an interpreter or a
link the agent makes runs as `pi-agent` as well, and meets the same
permissions. It is off until you switch it on in **Settings → Sandbox**.

## What runs in it

- **The shell.** Every command pi's `bash` runs, and whatever that command starts.
- **pi's file tools.** `read`, `write`, `edit` and `ls` do their reading and
  writing as `pi-agent`. `grep` and `find` search with `rg` and `fd`, which the
  portal runs as `pi-agent` too.
- **The environment.** Commands get a short list of variables: `PATH`, the
  language and terminal ones, and pi's own `PI_*` session variables. The portal's
  password, its secret and the provider keys are not among them, so `env` shows
  nothing worth taking. `HOME` is the sandbox's own folder, `/data/sandbox-home`.

## Paths

Each rule gives a path an access level, which counts for everything under it.
The most specific rule decides.

| Access | The agent may | Put on the files as |
| --- | --- | --- |
| No access | nothing: not read it, list it or pass through it | group root, no permissions for group or others |
| Read-only | read it and run what is in it, not change it | readable and runnable by everyone, writable only by root |
| Read & write | everything | owned by the group `pi-sandbox`, writable by it; new files keep the group |

A path no rule names keeps the permissions it has. For most of the system that
means readable and not changeable.

The defaults:

| Path | Access | Why |
| --- | --- | --- |
| `/workspaces` | read & write | the projects |
| `/data/agent-home`, `/data/agents` | read & write | the agents' homes |
| `/data/sandbox-home` | read & write | the sandbox's `HOME`: caches, tools it installs |
| `/data/bin` | read-only | commands on `PATH`: run, not changed |
| `/data/.secrets` | no access | keys for trusted commands |
| `/data/portal.db` | no access | the portal's database and settings |
| `/data/home` | no access | the portal's `HOME`: pi's `auth.json`, SSH keys, packages |
| `/data/sessions` | no access | every chat's transcript |
| `/data/browser-profile` | no access | the browser's cookies and logins |
| `/data/backups`, `/certs` | no access | database backups, the TLS key |

**Save and apply** sets owners and permissions at once. Under a read or write
rule it changes every file below it, which can take a while in a big workspace.
A read & write rule on `/workspaces` changes the group of your projects' files
to `pi-sandbox` (gid 10010), on the host as well.

## Trusted commands

Some jobs need a key the agent must not read: a script that reads a project
board or a channel's statistics with an API token. A trusted command is how:

1. The script goes in `/data/trusted`. The agent can run it and read it, not
   change it.
2. Its key goes in `/data/.secrets`.
3. In **Settings → Sandbox → Trusted commands**, add the command's name.

The script then runs as a second user, `pi-tools`, the only one that can read
`/data/.secrets`. The portal puts a small wrapper on `PATH` under the command's
name, so the agent types the name as before. The switch to `pi-tools` goes
through a `sudo` rule pinned to that one script, checked with `visudo` before it
is installed. The agent cannot run anything else as `pi-tools`, and cannot change
the script to make it do something else.

A script already in `/data/bin` under that name is moved into `/data/trusted`
when you apply.

A trusted command must not print its own key: what it prints, the agent reads.

## Not covered yet

- **Subagents** start a separate pi process, as the portal's user.
- **MCP servers** that pi starts, and **an extension's own tools** that start
  programs, run as the portal's user.
- **The Terminal panel** is yours, not the agent's, and is not sandboxed.
- **The network.** What the agent can read, it can still send. Limiting where
  it may connect is a separate step.

With the [container executor](/guide/deploying), each chat runs in a container
of its own, and this page does not apply.

## Requirements

The sandbox needs the portal to run as root on Linux, as the Docker image does:
it has to change to another user and set permissions. The image makes the users
`pi-agent` (uid 10001) and `pi-tools` (uid 10002) and the group `pi-sandbox`
(gid 10010), and installs `sudo`, `ripgrep` and `fd-find`. On another install,
create the same users and group and install those packages; the page says what
is missing.
