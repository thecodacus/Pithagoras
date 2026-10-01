# Configuration

Configuration comes from four places. Knowing which one wins saves a lot of
confusion.

## The four layers

| Layer | Set from | Applies to |
| --- | --- | --- |
| Session | The pills under the composer | One session |
| Portal | Settings → General | New sessions |
| Environment | Compose / `.env` | The deployment |
| pi | `~/.pi/agent/settings.json` | pi itself, everywhere |

For model, effort and provider, they resolve in that order — first non-empty
wins, with a last-resort constant behind pi:

```
session → portal override → environment → pi settings.json → fallback
```

Everything past the session layer is a *default*. A session that has made its
own choice keeps it, and changing a default never rewrites a running session.

::: tip Empty means inherit
`PI_PROVIDER`, `PI_MODEL` and `PI_THINKING_LEVEL` are overrides, and they are
empty in the compose file on purpose. Give them a value and pi's own
`settings.json` can never be reached. The same is true in Settings → General:
an empty field inherits, and clearing one hands the setting back.
:::

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORTAL_PASSWORD` | — | Required. The single login password; the portal will not start without it. |
| `PORTAL_ALLOW_NO_PASSWORD` | — | `1` runs with no login at all. Only safe behind a reverse proxy that authenticates, with the port unreachable otherwise. |
| `PORTAL_SECRET` | random | Signs the cookie. Set it to survive restarts. |
| `PORT` | `4100` | Listen port. |
| `DATA_DIR` | `./data` (image: `/data`) | Where `portal.db` lives. |
| `PITHAGORAS_VERSION` | `latest` | The release the Portainer stack runs, such as `0.2.0`. See [Upgrading](/guide/upgrading#pin-a-version). |
| `PORTAL_UPGRADE_BACKUP` | — | `skip` upgrades the database without backing it up first, for a disk that cannot hold the copy. See [Upgrading](/guide/upgrading). |
| `SESSION_DIR` | `./data/sessions` (image: `/data/sessions`) | One folder per session, holding pi's conversation file. Removed when the session is deleted — with the container executor, a file written by another user can keep a folder from going; that is logged. |
| `WORKSPACE_ROOT` | `/workspaces` | Directories sessions can be created against. |
| `BIN_DIR` | `/data/bin` | Persistent CLI installation directory added to PATH. |
| `PI_CODING_AGENT_DIR` | `$HOME/.pi/agent` | Override pi’s settings/package directory. |
| `LLAMA_BASE_URL` | — | Read by pi’s installed llama extension; not by the portal directly. |
| `CHANNELS_DIR` | `/data/channels` | Installed channel packages. |
| `AGENT_HOME` | `/data/agent-home` | The agent session's directory. |
| `HOME` | `/data/home` | pi's home — its settings and packages. |
| `EXECUTOR` | `host` | `host` or `container`. |
| `PI_IMAGE` | `pithagoras-runner:latest` | Image for the container executor. |
| `TASK_MEMORY_MB` | `2048` | Container executor memory ceiling. |
| `TASK_CPUS` | `2` | Container executor CPU ceiling. |
| `TASK_PIDS_LIMIT` | `512` | Container executor process ceiling. |
| `PI_PROVIDER` | — | Override for pi's `defaultProvider`. |
| `PI_MODEL` | — | Override for pi's `defaultModel`. |
| `PI_THINKING_LEVEL` | — | Override for pi's `defaultThinkingLevel`. |
| `PI_SUBAGENT_BIN` | `pi` | The `pi` the bundled subagent tool starts. |
| `MEMORY_UNDERSTORY_URL` | `http://localhost:3800/mcp` | Where Settings → Add-ons → Memory looks for Understory first. |
| `MEMORY_UNDERSTORY_AUTH_TOKEN` | — | Understory's bearer token, named in `mcp.json` rather than copied into it. |
| `UNDERSTORY_PORT` | `3800` | The port the Understory the portal runs listens on (host network). |
| `NPM_REGISTRY_URL` | `https://registry.npmjs.org` | Registry the package catalogue in Settings → Extensions searches. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | The Docker socket the managed add-ons use. |
| `PORTAL_CONTAINER_NAME` | — (Compose: `pithagoras`) | The portal's own container name; managed voice joins its network, and the container executor finds its mounts through it. |
| `PORTAL_TLS_CERT` / `PORTAL_TLS_KEY` | — | Serve over HTTPS when both name a file. |
| `ALLOW_OPEN` | — | `1` lets a portal with no password listen on the network; without one it binds `127.0.0.1` only. |
| `GIT_SSH_COMMAND` | `ssh -o BatchMode=yes` | What the Git panel's fetch, pull and push run ssh with. |
| `LLAMA_DISK_CACHE_MODELS` | — | Comma-separated model names whose llama.cpp prompt cache is kept on disk between chats. |
| `UNDERSTORY_VOLUME` | `pithagoras_understory-memory` | The volume holding that Understory's memory. |
| `VOICE_GPU` | — | The GPU index the managed voice container uses, as `nvidia-smi` lists them, where no GPU is chosen on the page (which wins). Empty: the card with the most free memory. See [Docker add-ons](/guide/add-ons#engines-and-gpu-memory). |
| `VOICE_VRAM_RESERVE_MIB` | — | GPU memory in MiB the voice installer keeps free on its card for something else. |
| `NVIDIA_SMI` | `nvidia-smi` | The binary the voice installer reads the GPUs with, for a native portal where it is not on `PATH`. |

The Browser add-on's `BROWSER_*` variables are in [Docker add-ons](/guide/add-ons), and the `VOICE_*` ones in [Voice control](/guide/voice).

Settings that are kept in the browser rather than on the server — theme, language,
notifications, confirmations, shortcuts — are in [The interface](/guide/interface).

The host executor inherits the portal environment. The container executor currently forwards `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PI_PROVIDER`, and `PI_MODEL`; it does not forward arbitrary extension variables. Explicit session provider/model choices are passed as CLI arguments.

Both Compose files forward `PI_IMAGE` and the three `TASK_*` limits. These limits apply only to `EXECUTOR=container`: memory must be an integer of at least 6 MiB, CPUs must be positive (fractions are allowed), and the process limit must be a positive integer. Empty values inherit defaults; zero, negative and non-numeric values are rejected explicitly.

`HOME` on the data volume is load-bearing. Point it back at the container
filesystem and every image rebuild silently wipes the pi packages you installed.

## pi's settings.json

Lives at `$HOME/.pi/agent/settings.json` — `/data/home/.pi/agent/settings.json`
in the container. Editable from Settings → Advanced, which validates it as JSON
before writing; a broken file stops every future session from starting.

```json
{
  "defaultProvider": "llama-server=http://192.168.1.101:8080",
  "defaultModel": "qwen36-35b-a3b-mtp",
  "defaultThinkingLevel": "high",
  "packages": ["npm:pi-llama-cpp"],
  "llamaServerUrl": "http://192.168.1.101:8080",
  "compaction": { "enabled": true }
}
```

`subagentMode` (`"background"`, or absent for interrupt),
`subagentMaxParallel` (how many at once; absent for 1, at most 16) and
`subagentModel` (`"provider/model"`, or absent for the chat's own) are read by
the bundled subagent tool; Settings → Add-ons → Subagents writes them. See
[Opt-in features](/guide/features).

Extension settings live here too, alongside pi's own. That is why the portal
writes single keys rather than replacing the file: a wholesale overwrite would
take the `packages` list with it.

## Portal settings

Stored in the `settings` table, edited in Settings → General. Saving an empty
value **deletes** the row rather than storing an empty string, which is what
makes "inherit" reachable again after you have set something.

The `GET /api/settings` response separates the three so a client can tell them
apart:

```json
{
  "settings": { "provider": "llama-server=…", "model": "qwen36-35b-a3b-mtp" },
  "stored":   {},
  "defaults": { "provider": "llama-server=…", "model": "qwen36-35b-a3b-mtp" }
}
```

`stored` empty and `settings` matching `defaults` means everything is inherited
— nothing is pinned.
