# HTTP API

Everything the web UI does goes through this API, so anything the UI can do you
can script.

All routes are under `/api`. When password authentication is enabled, everything except `/api/auth/*` requires the login cookie.

```bash
curl -s -c jar -X POST localhost:4100/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"password":"…"}'

curl -s -b jar localhost:4100/api/sessions
```

## Auth

| | |
| --- | --- |
| `GET /api/auth/status` | `{ authRequired, authed }` |
| `POST /api/auth/login` | `{ password }` → sets the cookie |
| `POST /api/auth/logout` | clears the cookie, and refuses the login it held from then on |

## Workspaces

| | |
| --- | --- |
| `GET /api/workspaces` | `{ root, workspaces: [{ name, path, isGit }] }` |
| `POST /api/workspaces` | `{ name }` → creates a directory; the name is slugified |

## Projects

The folders made on purpose for chats to work in: every folder directly under the
workspace root. Home, where chats start, is the agent's directory and not one of
them. See [Projects](/guide/projects).

| | |
| --- | --- |
| `GET /api/projects` | `{ root, projects: [{ name, path, isGit, hasInstructions, hasTools, sessions, lastActive }] }`; `hasTools` is whether the project switches tools differently from the portal-wide default |
| `POST /api/projects` | `{ name, instructions?, toolsOff? }` → creates the folder (slugified) and writes `AGENTS.md` if there are instructions; 409 if it exists, 400 for `home`. `toolsOff` is the tools its chats start with off, as for `PUT /api/projects/:name/tools`, checked before the folder is made. If the folder is made and the tools cannot be stored, the answer is the project with a `toolsError` |
| `GET /api/projects/:name` | The project plus `{ files, bytes, complete }` — what deleting it would remove |
| `GET /api/projects/:name/instructions` | `{ text }` |
| `PUT /api/projects/:name/instructions` | `{ text }` → writes `AGENTS.md`; blank removes it. |
| `GET /api/projects/:name/tools` | `{ tools, live, off, names }`, shaped like a conversation's list: every tool the portal has seen and whether it is on for chats in this project, with `defaultOn` the portal-wide default. `live` is always false |
| `PUT /api/projects/:name/tools` | `{ off: string[] }` — the tools chats in this project start with; what is not named is on. Stored as the difference from the portal-wide default, and told to the running chats in the project. Answers `{ off, applied }` |
| `DELETE /api/projects/:name` | Deletes its chats (with their conversation files) and its folder; 409 while one is running |

## Sessions

| | |
| --- | --- |
| `GET /api/sessions` | `{ sessions, executor }` — pinned first, then most recent. Task sessions only. |
| `GET /api/agent/sessions` | `{ sessions, agentHome }` — one agent's conversations (`?agent=`, the first agent without it), each with the channel that owns it |
| `POST /api/sessions` | `{ workspace?, agent?, title? }` — `agent` starts it in that agent's home; neither means Home, the first agent's; no title means "New chat", replaced by the first message |
| `GET /api/sessions/:id` | One session |
| `PATCH /api/sessions/:id` | `{ title?, pinned? }` — a title is cut to 120 characters |
| `DELETE /api/sessions/:id` | Stops it if running, then deletes it, its events and pi's conversation file for it (in `SESSION_DIR`). The folder it worked in is left alone. |

A session:

```json
{
  "id": "12_A1zVAa2rk",
  "title": "test-project",
  "workspace": "/workspaces/test-project",
  "executor": "host",
  "status": "idle",
  "pinned": false,
  "live": true,
  "created_at": "…",
  "updated_at": "…",
  "last_error": null
}
```

`status` is one of `idle`, `running`, `error`, `interrupted`. `live` is whether
a pi process is up right now, which is not the same thing — an idle session can
still be live.

## Files

The files in the folder a session works in, whether that is a project, the
workspace root or Home. Every path is relative to that folder; one that leads
out of it, by `..` or by a link, is refused with 400.

| | |
| --- | --- |
| `GET /api/sessions/:id/files?path=` | `{ path, entries: [{ name, type, link?, size, mtime }], truncated }` — `type` is `dir`, `file` or `link` (a link that leads out of the folder or nowhere); `link: true` marks every link, including one to a folder inside this one that is listed as a `dir`. Folders first; `.git` is left out; at most 2,000 entries |
| `GET /api/sessions/:id/file?path=` | `{ binary: false, size, mtime, content }`, or `{ binary: true, size, mtime }` for what is not text or is over 1 MB |
| `GET /api/sessions/:id/file?path=&download=1` | The file, as a download |
| `GET /api/sessions/:id/picture?path=` | A PNG, JPEG, GIF or WebP in the folder, to be drawn in the page, with the type its first bytes say it is and a `sandbox` content security policy. 400 for anything that is not one of those four, whatever its name; 413 over 25 MB. The Files panel, canvases and `show_image` use it |
| `PUT /api/sessions/:id/file?path=` | `{ content, mtime? }` → saves it. With `mtime`, the time it was read at, the save is refused with 409 if the file has changed since. 413 over 1 MB |
| `PUT /api/sessions/:id/file?path=` with `create: true` | `{ content, create: true }` → makes the file, and refuses with 409 if something already has the name |
| `POST /api/sessions/:id/folder?path=` | `{ name }` → makes a folder in the folder at `path`, answers `{ path }`. 409 if the name is taken |
| `POST /api/sessions/:id/upload?path=&name=` | The file as the request body, sent as `application/octet-stream` → put in the folder at `path` as `name`, or `name (2)` and so on if that is taken; answers `{ path, size }`. Streamed to disk and put in place only once complete. 413 over 2 GB |
| `PATCH /api/sessions/:id/file?path=` | `{ name }` → gives a file or folder another name in the same folder, and answers `{ path }`. 400 for a name with a `/` or `\`, or `.` or `..`; 409 if the name is taken. A link is renamed as the link |
| `DELETE /api/sessions/:id/file?path=` | Removes a file, or a folder and all in it; a link is removed as the link. The folder itself is refused |
| `GET /api/sessions/:id/archive?path=` | The folder — or, with `path`, a folder in it — as a `.tar.gz`, without `node_modules`, `.git`, `dist`, `build` and virtual environments. If `tar` cannot run the answer is a 500; if it fails part-way the download is cut off, so it does not end as if it were whole. A file that changes while it is read is not a failure |

## Prompting

| | |
| --- | --- |
| `POST /api/sessions/:id/prompt` | `{ message, images?, voice?, steer? }` — `images` is up to eight `{ data }`, each base64 or a `data:` URL of a PNG, JPEG, GIF or WebP under 5 MB. The type is read from the bytes. `message` may be empty when there are pictures. Sent while a run is going, a message waits for the run to end; with `steer: true` it goes into that run instead, after the tools running now |
| `GET /api/sessions/:id/images/:name` | A picture sent with a message; `portal_prompt` events name them in `payload.images` |
| `POST /api/sessions/:id/abort` | Stop the current run |
| `POST /api/sessions/:id/ui-response` | `{ id, value?, cancelled? }` — answer an extension dialog |
| `GET /api/tools` | `{ tools, off }` — every tool the portal has seen, and which are off by default |
| `PUT /api/tools` | `{ off: string[] }` — the default for every conversation; applied to the running ones too. A [project](#projects) can bend it with `PUT /api/projects/:name/tools`, and a conversation then holds its exceptions against that |
| `GET /api/sessions/:id/tools` | `{ tools, live, off }` — every tool the conversation could use and whether it is on. `live` is false when pi is not running to be asked |
| `PUT /api/sessions/:id/tools` | `{ off: string[] }` — switch tools off by name; everything not named is on |
| `GET /api/tool-names` | What each package is called here; everything unnamed keeps its own name |
| `PUT /api/tool-names` | `{ names }` — a name per package, MCP server or `built in`. An empty one removes it |

`prompt` returns as soon as pi accepts the message, **not** when the work
finishes. Watch the event stream for progress.

A message matching a portal builtin is handled without reaching the model — see
[Slash commands](/guide/commands).

## Events

```
GET /api/sessions/:id/events?since=<seq>
```

Server-sent events. A nonzero `since` replays stored events after that cursor, in batches, then tails live. A cold load (`since=0`) starts with up to the latest 1,200 stored events. Use `GET /api/sessions/:id/events/before?before=<seq>&limit=1200` for earlier pages (maximum 3,000 per page).

Each data message is one event:

```json
{ "seq": 78, "type": "portal_notice", "payload": { "text": "…" } }
```

Track the highest `seq` you have seen and pass it as `since` when reconnecting.

::: warning Negative seq
Live-only events — streaming message/tool updates, queue updates, prefill progress and extension dialogs — carry a negative `seq`. They are never
persisted, so they must not move your cursor. Ignore anything `<= 0` when
tracking position, or reconnecting will skip real history.
:::

Types worth knowing: `portal_prompt`, `portal_status`, `portal_notice`,
`agent_end`, `extension_ui_request`, `extension_ui_cancel`, `extension_error`,
`stderr`, `queue_update`, `portal_prefill`, `message_update`, `message_end`, `tool_execution_update`, and `tool_execution_end`, plus other pi lifecycle events.

Completed assistant messages and tool results are saved; their streaming updates stay in memory. On connection, the named `live-reset` event tells a client to discard stale in-memory updates before replay. A `message_snapshot` restores the current assistant message; tool updates restore current tool output. The named `caught-up` event carries the last durable sequence. Render completed `message_end.message` content even when no deltas were replayed.

## Session config

| | |
| --- | --- |
| `GET /api/sessions/:id/config` | `{ state, thinking, models, stats, contextLimit }` |
| `POST /api/sessions/:id/config` | `{ provider?, modelId?, thinkingLevel?, autoCompaction?, autoRetry? }` |
| `PUT /api/context-limit` | `{ provider, model, tokens }` — the context window this model really has here; `tokens: null` goes back to the default, or the model's own |
| `PUT /api/context-default` | `{ tokens }` — a ceiling on the window of every model; `null` removes it. Also returned by `GET /api/settings` as `contextDefault` |
| `POST /api/sessions/:id/compact` | Compact now |
| `GET /api/sessions/:id/commands` | The slash command palette |

`GET` does not start pi. While it is not running the response is `live: false`
with the stored model and effort, empty `thinking` and `models`, and
`stats: null`; once it is, it carries context usage and token counts.

When pi is running, the response also has `contextLimit`, the window set with
`PUT /api/context-limit` or `null`, and `contextDefault`, the ceiling from
`PUT /api/context-default`. Both apply to open chats at once, and `contextLimit`
is per model rather than per chat. `contextLimitSupported` is `false` when pi
cannot be given a window (see below). None of the three is in the `live: false`
response.

With `EXECUTOR=container` both `PUT` routes answer 400: pi runs in the container
behind an RPC client, and the portal cannot change the model it measures
against. `tokens` must
be a whole number from 1,024 to 10,000,000.

`GET /api/sessions/:id/models` starts pi when necessary and returns the live model list and state.

`POST` returns `{ ok, applied, state }`, where `applied` lists what actually
changed. Only those fields are persisted — an effort change does not rewrite the
model.

`compact` fails with a message when the session is too short for pi to bother.

## Editing messages

| | |
| --- | --- |
| `DELETE /api/sessions/:id/messages/:seq` | Removes a message and the agent's answer to it. 409 while the chat is running, 404 for an unknown message |
| `POST /api/sessions/:id/messages/:seq/edit` | `{ message }` — replaces the message: it and everything after it are dropped, and the new text is sent. The old text stays as another version |
| `POST /api/sessions/:id/messages/:seq/version` | `{ to }` — shows another version of the message, and what followed it then |
| `PUT /api/sessions/:id/draft` | `{ text, caret?: { start, end } }` — what is in the chat box, which an extension can ask for. Starts nothing |
| `GET /api/sessions/:id/stats` | Context usage and token counts, without the model catalogue |
| `GET /api/sessions/:id/models` | The live model list; starts pi when necessary |

## Git

The Git panel's routes, all for the folder of session `:id`. Each is refused when
the folder is not a repository, except `init`. See [Git](/guide/git).

| | |
| --- | --- |
| `GET /api/sessions/:id/git` | Branch, upstream, ahead/behind, changed files, an operation in progress. Reads the disk only |
| `GET /api/sessions/:id/git/gh` | Whether pull requests can be had through `gh`, and for which GitHub repository. `?fresh=1` asks again |
| `POST /api/sessions/:id/git/init` | Make the folder a repository |
| `GET /api/sessions/:id/git/diff?of=` | A diff: `of` is `unstaged`, `staged`, `untracked` (with `path`), `commit` (`sha`), `range` (`base`) or `stash` (`stash`) |
| `POST …/git/stage` · `/unstage` · `/discard` | `{ paths }` or `{ all: true }` (not for `discard`) |
| `POST …/git/commit` | `{ message, amend? }` |
| `POST …/git/abort` · `/continue` | Abort or continue a paused merge or rebase |
| `GET …/git/log` · `GET …/git/commits/:sha` | History, in pages; one commit with its files |
| `GET …/git/branches` · `POST …/git/branches` · `POST …/git/branches/delete` | List, `{ name, from? }`, `{ name, force? }` |
| `POST …/git/switch` | `{ name, remote? }` |
| `POST …/git/fetch` · `/pull` · `/push` | Each answers `{ said }`; pull is fast-forward only |
| `GET …/git/stashes` · `POST …/git/stashes` | List; `{ message? }` stashes the changes. `POST …/git/stashes/apply` · `/pop` · `/drop` with `{ ref, sha? }` act on one |
| `GET …/git/compare?base=` | The branch against its base |
| `GET …/git/pulls?state=` · `…/pulls/current` · `…/pulls/:n` · `…/pulls/:n/diff` | Pull requests, through `gh` |
| `POST …/git/pulls` | `{ title, body, base?, draft? }` |
| `POST …/git/pulls/:n/checkout` · `/merge` · `/comment` · `/review` | `merge`: `{ method, deleteBranch? }`; `comment`: `{ body }`; `review`: `{ action, body }` |

## Terminal, background jobs and subagents

| | |
| --- | --- |
| `POST /api/terminal` | `{ sessionId? }` → opens a shell in that session's folder (home otherwise); answers `{ id, cwd }` |
| `GET /api/terminal/:id/stream` | Server-sent events: its output |
| `POST /api/terminal/:id/input` · `/resize` | Keystrokes; the size of the panel |
| `DELETE /api/terminal/:id` | Ends the shell |
| `GET /api/sessions/:id/background` | `{ supported, jobs, …extension status, piRunning }` — background jobs are listed on the host executor on Linux only |
| `GET /api/sessions/:id/background/:key/output` | A job's output; 404 when it is not in a file the portal can follow |
| `POST /api/sessions/:id/background/:key/stop` · `/background/clear` | Stop one; clear the finished ones |
| `POST /api/sessions/:id/subagents/:agent/input` | `{ text }` — say something to a running subagent. 409 when it cannot be reached |
| `POST /api/sessions/:id/subagents/:agent/stop` | Stop it |

## Model providers

| | |
| --- | --- |
| `GET /api/providers` | The providers pi knows, without their keys |
| `GET /api/providers/status` | Whether each server answers now |
| `POST /api/providers/probe` | Ask a server for its models, before or after it is saved |
| `PUT /api/providers/:id` | `{ kind, adding?, baseUrl?, api?, apiKey?, models? }` — 409 if `adding` and the id is taken |
| `DELETE /api/providers/:id` | Remove one |
| `GET /api/models` | Every model pi can use now — the ones with a key |
| `GET /api/packages/catalog?q=&topic=` | Packages published for pi; `topic=provider` narrows to provider packages |
| `GET /api/features/flags` | Only which opt-in features are on — for the sidebar and menus |

See [Models and providers](/guide/models).

## Browser add-on

| | |
| --- | --- |
| `GET /api/browser` | State, connection and settings |
| `POST /api/browser/install` · `/start` · `/stop` | Lifecycle of the managed container |
| `DELETE /api/browser/install` | Remove it; `?profile=forget` drops the logins too |
| `POST /api/browser/connect` · `DELETE /api/browser/connect` | Give the agent the browser's tools, or take them away |
| `PUT /api/browser/config` · `GET /api/browser/suggest-password` | The login of the browser view; a suggestion |
| `PUT /api/browser/allowlist` | Domains it may be pointed at; empty means no restriction |
| `PUT /api/sessions/:id/browser` | Whether this chat may use it |

See [The agent's browser](/guide/browser).

## Voice

| | |
| --- | --- |
| `GET /api/voice` · `PUT /api/voice` | The voice settings, including the speaking instructions in use and the built-in ones to go back to. `runtime` may be `none` (no speech synthesis, with no speech URL), and `speech` is then `false`: the page offers dictation and not voice mode, and `…/voice/speech` answers 409 |
| `GET /api/voice/install` · `POST /api/voice/install` · `/start` · `/stop` | The managed voice container and its readiness, with the `choice` it was built for. `POST /api/voice/install` takes `{ tts, asr, asrModel, asrDevice? }` — `tts` is `breeze`, `chatterbox` or `none` (speech recognition only, which needs no GPU); `asr` and `asrModel` are `whisper` with `base` or `small`, or `qwen3-asr` with `0.6b` or `1.7b`; `asrDevice` is `cpu` or `gpu`, where `gpu` is the default for Qwen3-ASR beside a speech engine and Whisper and recognition-only are always `cpu` — and builds for it, recreating an installed container that has other engines. Without a body it keeps the installed engines, or picks the combination that fits the GPU, or recognition alone where there is none. A choice the GPU or the host's memory cannot hold at all, and speech synthesis on a host without a GPU, is refused after the check, in the status `error`; `400` for a combination that does not exist |
| `GET /api/voice/hardware` | The GPUs the voice container can use (`gpus`, each with `index`, `uuid`, `name`, `totalMiB`, `freeMiB`; `source` says how they were read), the one it would take (`selected`, an index), the one chosen with `PUT /api/voice/gpu` (`chosen`, a UUID, empty where none is or the one chosen is no longer there), the memory kept free (`reserveMiB`), the combination that fits (`suggestion`), what recognition on the CPU has to run on (`host`: `totalMiB`, `freeMiB`, `threads`), whether the check could tell (`checked`) and whether it found there is no GPU (`cpuOnly`, with recognition alone as the suggestion). No GPU and no tool is `gpus: []`, not an error |
| `POST /api/voice/connect` | Use the managed services in the settings |
| `PUT /api/voice/gpu` | Choose the GPU the managed voice runs on: `{ gpu: uuid }` (a UUID from `GET /api/voice/hardware`), or `""` to leave it to `VOICE_GPU`, else to the card with the most free memory when engines are installed or rebuilt (a restart keeps the card the service is on). `400` for a UUID that no GPU has, and for a GPU that cannot hold the engines installed (the error says what would fit); nothing is saved or stopped then. A running service is recreated on a new choice at once, any other on its next start; `409` says the choice is saved but the restart could not begin |
| `GET/POST /api/voice/presets` · `GET …/presets/:id/audio` · `PATCH …/presets/:id` · `DELETE …/presets/:id` | Saved voices. `PATCH` takes `{ instruction }`, the voice description (1–1000 characters), and returns the voice; 404 for an unknown voice |
| `POST /api/sessions/:id/voice/connection` | Take or give back a lease on the voice services |
| `POST /api/sessions/:id/voice/transcribe` | `audio/wav` body (12 MB at most) → `{ text }` |
| `POST /api/sessions/:id/voice/speech` | Text → audio |

The session routes answer 409 until Voice is enabled in Settings → Add-ons. See [Voice control](/guide/voice).

## Canvases

| | |
| --- | --- |
| `GET /api/sessions/:id/canvases` · `POST` | List; `{ title }` creates one |
| `PUT /api/sessions/:id/canvases/:cid` | `{ revision, title, content }` — 409 when `revision` is stale |
| `POST /api/sessions/:id/canvases/:cid/persist` | Store a temporary canvas |
| `DELETE /api/sessions/:id/canvases/:cid` | Delete |

## Portal settings

| | |
| --- | --- |
| `GET /api/settings` | `{ settings, stored, defaults, piSettingsPath, executor, workspaceRoot }` |
| `PUT /api/settings` | `{ provider?, model?, thinkingLevel? }` |

`settings` is what pi is launched with; `stored` is only your explicit
overrides; `defaults` is what an unset field falls back to. An empty string in
`PUT` clears an override rather than storing a blank.

## pi extensions

| | |
| --- | --- |
| `GET /api/packages` | Raw `pi list` output |
| `POST /api/packages` | `{ spec }` |
| `DELETE /api/packages` | `{ spec }` |
| `POST /api/packages/update` | Update everything |
| `GET /api/extensions` | Parsed packages with their recovered settings |
| `PUT /api/extensions/enabled` | `{ spec, enabled }` — switch a package off or on without uninstalling it; reloads idle open sessions and says how many were left waiting |
| `PUT /api/extensions/settings` | `{ key, value }` — empty value removes the key |
| `GET /api/pi-settings` | Raw `settings.json` |
| `PUT /api/pi-settings` | `{ content }` — refused unless it parses as JSON |

## Opt-in features

| | |
| --- | --- |
| `GET /api/features` | `{ subagent: { available, installed, enabled, source, mode, maxParallel }, understory: { enabled, url, tokenSet, adapterInstalled, reachable, managed: { available, image, container, pulling, url, config, providers } } }` — `config` never holds a key |
| `PUT /api/features/subagent` | `{ enabled?, mode?: "interrupt" \| "background", maxParallel?: 1–16, model?: "auto" \| "provider/model" }` — installs or removes the bundled subagent tool, writes `subagentMode`, `subagentMaxParallel` and `subagentModel`; reloads idle open sessions |
| `GET /api/sessions/:id/subagent-model` | `{ model, default }` — what this chat's subagents run on: its own choice (`null` follows `default`) |
| `PUT /api/sessions/:id/subagent-model` | `{ model: null \| "auto" \| "provider/model" }` |
| `PUT /api/features/understory` | `{ enabled, url? }` — writes or removes the `understory` MCP server (installing `pi-mcp-adapter` if needed); reloads idle open sessions |
| `PUT /api/features/understory/config` | `{ llm: { source: "auto" } \| { source: "provider", provider, model } \| { source: "custom", baseUrl, model, format, apiKey? }, dreamInterval, dreamAt }` — `auto` (the default) thinks with the model of the chat asking — `dreamAt` ("03:00") tidies up once a day at that time and wins over `dreamInterval` — the model and tidying up of the portal's own Understory; a running one is made again with them. `apiKey` left out keeps the saved one |
| `POST /api/features/understory/install` | Pull, create and start the portal's own Understory, and make it the agent's memory |
| `POST /api/features/understory/start` · `/stop` | Its container |
| `POST /api/features/understory/dream` | Tidy the memory up now; answers when the pass is done, with what it did |
| `DELETE /api/features/understory/install` | Remove it (the memory stays in its volume; `?memory=forget` deletes it too), and switch it off as the memory |
| `GET /api/memory/tree` | Understory's memory bundle as a tree of folders and notes — read through the portal while Understory is on (409 when it is not) |
| `GET /api/memory/concept?path=` | One note: `{ path, frontmatter, body }`; 404 when it is not there |
| `GET /api/memory/search?q=` | Notes matching, best first |
| `GET /api/memory/log` | What changed, newest first |
| `GET /api/memory/graph` | `{ nodes: [{ path, title, type, links }], edges: [{ source, target }] }` |
| `GET /api/memory/traces` | The paths Understory's own queries and changes took |
| `GET /api/memory/validate` | `{ conformant, conceptCount, directoryCount, issues }` |
| `GET /api/memory/health` | `{ writable, health? }` — whether notes can be changed here (the portal's own Understory, running), and what its checks find: `{ healthy, orphans, brokenLinks, issues }` |
| `PUT /api/memory/concept` | `{ path, frontmatter, body }` — write a note through Understory's own write path (its index and log follow); `frontmatter` needs `type` and `title`. Answers `{ concept, health }`; 409 unless writable |
| `DELETE /api/memory/concept?path=` | Delete a note the same way; answers `{ health }` |
| `POST /api/memory/reindex` | Every folder's index.md written anew and empty folders removed, no model; answers `{ pruned, reindexed, health }` |
| `POST /api/memory/repair` | The model mends links to nothing and wires in orphans, only when there are any; answers `{ ran, reason?, summary?, filesChanged?, health }` |
| `POST /api/memory/clear-log` | log.md back to its heading and the query paths removed; the notes stay |
| `POST /api/memory/wipe` | Every note and folder deleted, the root index and log as new, Understory started again |

## Channels

| | |
| --- | --- |
| `GET /api/channels` | `{ channels, kinds, broken, agentHome, channelsDir }` |
| `POST /api/channels` | `{ kind, name, config, agentId? }` — it talks as the first agent unless given another |
| `PATCH /api/channels/:id` | `{ name?, slug?, enabled?, config?, instructions?, agentId? }` — `agentId` is the agent it talks as |
| `DELETE /api/channels/:id` | Keeps its conversations; `?sessions=delete` discards them too |
| `POST /api/channel-packages` | `{ spec }` — install a channel package |
| `DELETE /api/channel-packages/:name` | Uninstall; refuses builtins |

A channel's `slug` is what agent sessions are keyed on, and it survives the
channel being deleted and recreated. Creating a channel with an explicit `slug`
reconnects it to the conversations that slug already had.

Secrets are never returned. A channel carries `secretsSet` listing which secret
fields have a value, and sending a blank secret keeps the stored one.

`broken` lists packages that failed to load, with the reason.

## Agents

Each agent has a home folder of its own, with its own `SOUL.md`,
`PrimaryUser.md` and `MEMORY.md`. The first agent (`home`) is the one at
`AGENT_HOME`; the others are made in `agents/` beside it.

| Route | Purpose |
| --- | --- |
| `GET /api/agents` | `{ agents }`, each `{ id, name, home, first, initialised, chats, channels, orb }` |
| `POST /api/agents` | `{ name, setup? }` — a new agent and its folder; `setup` takes the wizard's answers. A folder kept from a deleted agent of the same name is taken up again. |
| `PATCH /api/agents/:id` | `{ name }` — its folder stays where it is |
| `DELETE /api/agents/:id` | Deletes it and its chats, and its folder with `?folder=delete`. Refused for the first agent, for one a channel talks as, and while one of its chats or routines is working. Its routines are switched off. |
| `GET /api/agents/:id/setup` | Setup status and its editable files |
| `POST /api/agents/:id/setup` | Writes its identity files from the wizard's answers |
| `PUT /api/agents/:id/files/:name` | Saves one of its files |
| `PUT /api/agents/:id/orb` | Saves its avatar; answers the style as stored |
| `GET /api/agent/orb?session=` | The avatar voice mode shows for that chat: its agent's, or the first agent's |
| `POST /api/agent/sessions` | `{ agent?, title? }` — a conversation with that agent, the first without one |
| `GET /api/agent/setup`, `POST /api/agent/setup`, `PUT /api/agent/files/:name` | The same for the first agent |

## People and audit

| Route | Purpose |
| --- | --- |
| `GET /api/people` | List known people and roles. |
| `PATCH /api/people/:key` | Update name, role or notes. |
| `DELETE /api/people/:key` | Forget a person. |
| `GET /api/audit?limit=2000` | Read up to all 2,000 retained decisions (default 200), newest first. |
| `GET /api/tool-rules` | List standing tool permissions. |
| `POST /api/tool-rules` | Add a role/tool/pattern rule. |
| `DELETE /api/tool-rules/:id` | Remove a rule. |

## MCP servers

| Route | Purpose |
| --- | --- |
| `GET /api/mcp` | Read configured servers and settings. |
| `PUT /api/mcp/servers/:name` | Add or update a server. |
| `DELETE /api/mcp/servers/:name` | Remove a server. |
| `PUT /api/mcp/settings` | Update MCP settings. |
| `POST /api/mcp/import` | Import server configuration. |
| `PUT /api/mcp/raw` | Save the raw configuration after JSON validation. |

## Skills

| Route | Purpose |
| --- | --- |
| `GET /api/skills` | List skills, diagnostics and editable content. |
| `POST /api/skills` | Create a skill with name, description and body. |
| `PUT /api/skills/:name` | Save a skill's content. |
| `DELETE /api/skills/:name` | Delete an editable skill. |
| `POST /api/skills/:name/enabled` | Enable or disable a skill. |
| `POST /api/skills/preview-import` | Preview a repository import. |
| `POST /api/skills/import` | Import selected skills. |
| `POST /api/skills/:name/update` | Refresh an imported skill. |

## Routines

| Route | Purpose |
| --- | --- |
| `GET /api/routines` | List routines and defaults. |
| `POST /api/routines` | Create a recurring or one-off routine. |
| `PATCH /api/routines/:id` | Update a routine. |
| `DELETE /api/routines/:id` | Delete a routine. |
| `POST /api/routines/:id/run` | Start a run now. |
| `POST /api/routines/preview` | Preview schedule timing. |
| `GET /api/routines/:id/sessions` | List the routine's runs. |
| `GET /api/routines/report-targets` | List available report destinations. |
| `PUT /api/routines/report-default` | Set the default report destination. |

Recurring routines resume at their next future slot after a restart. Overdue one-off routines catch up.
