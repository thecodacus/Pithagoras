# MCP servers

MCP is how the agent reaches tools it does not ship with — a filesystem server,
a GitHub server, a company's internal one. Support comes from the
[`pi-mcp-adapter`](https://pi.dev/packages/pi-mcp-adapter) extension; the portal
owns the configuration and the adapter does the connecting.

Settings → **MCP**. If the adapter is not installed the panel says so and
offers to install it, because until then nothing reads this configuration.

## Where it is written

`<agent dir>/mcp.json` — `/data/home/.pi/agent/mcp.json` in the container. The
adapter reads several files in precedence order; this is the pi-global one, so
it applies to every session in the portal. A project-local `.mcp.json` would
only reach one workspace, which is the wrong shape here.

The file holds the servers' keys, and the token the portal made for its own
memory, so it is readable by the account the portal runs as and no other. It is
written whole or not at all: a full disk leaves the file as it was.

Changes are read when a session starts. A session already running keeps the
servers it connected with, so restart it to pick up a new one.

## Adding a server

Three ways, in descending order of effort:

**Paste JSON.** Every MCP project's README hands out the same snippet. The
import accepts a whole config, a bare `mcpServers` map, or a single server
object:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    }
  }
}
```

A server in the snippet whose name you already have is not imported over it: it
is listed as skipped, and the one you have stays as it is.

**The form.** Name, transport, then the fields for that transport. A server is
`stdio` (a local process), `http` (a URL), or a Unix socket — exactly one of
them.
A name that another server has is refused, whether the server is new or renamed:
it would replace that one, with everything the form does not show.

**The file.** "Edit the file directly" at the bottom of the panel, for anything
the form does not cover: OAuth blocks, tracing, per-server timeouts. The form
preserves fields it does not show, so an edit made there is not lost by a later
edit in the form.

## Secrets

Do not put a token in this file. For stdio servers, reference the environment:

```
GITHUB_TOKEN=${GITHUB_TOKEN}
```

`${VAR}` is expanded when the server launches. For HTTP servers with a bearer
token, the form asks for the *name* of the environment variable
(`bearerTokenEnv`), not the token. OAuth credentials never touch the file at
all — the adapter stores them in the OS credential store.

## Tools, and how many of them

By default the adapter exposes one `mcp` proxy tool and the model asks it for
what it needs. That keeps the system prompt small no matter how many servers are
configured.

**Register tools directly** puts a server's tools in the system prompt instead,
costing roughly 150–300 tokens each. Worth it for a server with a handful of
tools the agent uses constantly; expensive for a server with sixty.

`Only these tools` / `Except these tools` take names or globs and are the way to
keep a large server from crowding the prompt.

## Disabling

The toggle on each row sets `disabled: true` — the server stays configured and
visible but is never connected. Better than deleting a server you are debugging.
Deleting one, or renaming it, also takes its tools out of the Tools list.

::: tip The adapter has its own commands
`/mcp` opens its status panel, `/mcp tools` lists what is available, and
`/mcp reconnect` refreshes a server. They work in the portal's command palette
like any other extension command.
:::
