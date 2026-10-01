import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OrbStudio } from "./OrbStudio";
import {
  LuBot,
  LuCheck,
  LuFileText,
  LuFolder,
  LuMessageSquare,
  LuMonitor,
  LuPencil,
  LuPlus,
  LuRadio,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import { PageHeader, Stat } from "./PageHeader";
import { RowsSkeleton } from "./Skeleton";
import { api, type AgentSession, type AgentSetup as Setup } from "../api";
import { AgentSetup } from "./AgentSetup";
import { confirmDialog } from "./ConfirmDialog";
import { StatusDot } from "./StatusDot";
import { TitleInput } from "./TitleInput";
import { pollWhileVisible } from "../poll";
import { t } from "../i18n";
import { when } from "../time";

/**
 * The agent's conversations, one per chat rather than one overall.
 *
 * A channel package supplies a key for each conversation it sees — a Telegram
 * chat id, a Slack channel — and the portal turns each into its own session.
 * That is what stops a group chat and a DM sharing a memory. They are ordinary
 * sessions, so they open in the ordinary chat view.
 */
/** Conversations started here rather than arriving through a channel. */
const BROWSER = "browser";

export function AgentPage({ onSelect }: { onSelect: (id: string) => void }) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [home, setHome] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  // Kept apart from `error`: this one comes back by itself when the next
  // refresh works, and must not wipe out — or be wiped by — the answer to a
  // rename or a delete.
  const [loadError, setLoadError] = useState("");
  // The conversation whose name is open for editing, if any.
  const [renaming, setRenaming] = useState<string | null>(null);

  const load = () =>
    api
      .agentSessions()
      .then((r) => {
        setSessions(r.sessions);
        setHome(r.agentHome);
        setLoadError("");
      })
      // The list stays as it was rather than being emptied, and the page says
      // it is out of date: an empty list that is really a failed fetch reads as
      // "the agent has no conversations".
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));

  useEffect(() => {
    api.agentSetup().then(setSetup).catch(() => {});
    load();
    return pollWhileVisible(load, 5000);
  }, []);

  /**
   * Rename and delete, as the sidebar does them: these are the same sessions,
   * and the same two routes. Deleting one that arrived through a channel does
   * not block the chat — the next message in it simply starts a new
   * conversation, which is the reason to say so first.
   */
  const rename = async (s: AgentSession, next: string) => {
    setRenaming(null);
    setError("");
    try {
      await api.renameSession(s.id, next);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (s: AgentSession) => {
    const fresh = s.channel && s.channel.slug !== BROWSER;
    const ok = await confirmDialog({
      title: t("Delete \"{name}\"?", { name: s.title }),
      message: fresh
        ? t("The agent forgets this conversation, and the next message in that chat starts a new one.")
        : t("It is stopped if it is running, and its transcript is removed."),
      confirmLabel: t("Delete"),
      danger: true,
      deletes: true,
    });
    if (!ok) return;
    setError("");
    try {
      await api.deleteSession(s.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Grouped by the door each conversation came through.
  const groups = useMemo(() => {
    const out = new Map<
      string,
      { name: string; kind: string | null; present: boolean; items: AgentSession[] }
    >();
    for (const s of sessions) {
      const key = s.channel?.slug ?? "none";
      if (!out.has(key)) {
        out.set(key, {
          name: s.channel?.name ?? "",
          kind: s.channel?.kind ?? null,
          // A browser conversation has no channel by design, so it must not be
          // flagged as one whose channel went missing.
          present: key === BROWSER ? true : (s.channel?.present ?? false),
          items: [],
        });
      }
      out.get(key)!.items.push(s);
    }
    return [...out.entries()];
  }, [sessions]);

  // Nothing else on this page means much until the agent has a character and
  // knows who it is talking to.
  if (setup && !setup.initialised) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <AgentSetup home={setup.home} onDone={setSetup} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <PageHeader
            icon={<LuBot />}
            title={t("Agent")}
            description={
              <>
                {t("Conversations that reached the agent through a channel. Each chat gets its own session, so a group and a DM never share a memory.")}
              </>
            }
            action={
              <button
                onClick={async () => {
                  setStarting(true);
                  try {
                    onSelect((await api.startAgentChat()).id);
                  } finally {
                    setStarting(false);
                  }
                }}
                disabled={starting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-1.5 text-sm text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
              >
                {starting ? (
                  <LuRefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <LuPlus className="h-4 w-4" />
                )}
                {t("New conversation")}
              </button>
            }
          >
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Stat value={sessions.length} label={t("conversations")} />
              <Stat value={sessions.filter((s) => s.status === "running").length} label={t("running")} tone="text-accent" />
              <div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-raised/60 px-2.5 py-1">
                <LuFolder className="h-3 w-3 shrink-0 text-fg-faint" />
                <span className="truncate font-mono text-[11px] text-fg-subtle">{home}</span>
              </div>
            </div>
          </PageHeader>

          {setup?.initialised && <AgentFiles setup={setup} onSaved={setSetup} />}

          <OrbStudio />

          {loadError && (
            <div className="mt-4 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
              {t("Could not refresh the conversations — what is shown may be out of date.")} {loadError}
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
          )}

          {loading ? (
            <RowsSkeleton />
          ) : sessions.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-line px-4 py-10 text-center">
              <p className="text-sm text-fg-muted">{t("Nothing has reached the agent yet.")}</p>
              <p className="mx-auto mt-2 max-w-md text-xs text-fg-faint">
                {t("Start one here, or message a channel — a Telegram chat, a webhook — and it appears in this list. They all reach the same agent and share its memory.")}
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              {groups.map(([id, group]) => (
                <section key={id}>
                  <div className="flex items-center gap-2 px-1">
                    {id === BROWSER ? (
                      <LuMonitor className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                    ) : (
                      <LuRadio className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                    )}
                    <h3 className="truncate text-xs font-medium text-fg-muted">{id === BROWSER ? t("Here, in the portal") : group.name || t("No channel")}</h3>
                    {group.kind && id !== BROWSER && (
                      <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                        {group.kind}
                      </span>
                    )}
                    {!group.present && (
                      <span
                        className="shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn/90"
                        title={t("Recreate a channel with the slug \"{slug}\" to reconnect these", { slug: id })}
                      >
                        {t("no channel")}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                      {group.items.length}
                    </span>
                  </div>

                  <ul className="stagger-in mt-1.5 space-y-1">
                    {group.items.map((s) => (
                      <li key={s.id} className="group relative">
                        {renaming === s.id ? (
                          // Not a button while the name is being typed: an input
                          // inside one cannot be focused reliably, and a click in
                          // the field must not open the conversation.
                          <div className={ROW}>
                            <RowBody
                              s={s}
                              title={
                                <TitleInput
                                  value={s.title}
                                  label={t("Conversation name")}
                                  className="w-full text-sm"
                                  onCommit={(next) => rename(s, next)}
                                  onCancel={() => setRenaming(null)}
                                />
                              }
                            />
                          </div>
                        ) : (
                          <>
                            <button onClick={() => onSelect(s.id)} className={`${ROW} hover:bg-fg/5`}>
                              <RowBody
                                s={s}
                                title={<p className="truncate text-sm text-fg">{s.title}</p>}
                              />
                            </button>
                            {/* Over the timestamp rather than beside it: the row is
                                a button, and one button cannot hold another. */}
                            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                              <button
                                onClick={() => setRenaming(s.id)}
                                title={t("Rename")}
                                aria-label={t("Rename {name}", { name: s.title })}
                                className="rounded p-1.5 text-fg-subtle transition hover:text-accent"
                              >
                                <LuPencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => remove(s)}
                                title={t("Delete conversation")}
                                aria-label={t("Delete {name}", { name: s.title })}
                                className="rounded p-1.5 text-fg-subtle transition hover:text-danger"
                              >
                                <LuTrash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ROW =
  "flex w-full items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5 text-left transition";

/** What a conversation row shows, whether or not its name is being edited. */
function RowBody({ s, title }: { s: AgentSession; title: ReactNode }) {
  return (
    <>
      <StatusDot status={s.status} />
      <div className="min-w-0 flex-1">
        {title}
        <p className="truncate font-mono text-[10px] text-fg-faint">{s.channel_key}</p>
      </div>
      <LuMessageSquare className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
      <span className="shrink-0 text-[11px] text-fg-faint group-hover:invisible group-focus-within:invisible [@media(hover:none)]:hidden">
        {when(s.updated_at)}
      </span>
    </>
  );
}

/** The files that define the agent, editable in place. */
function AgentFiles({ setup, onSaved }: { setup: Setup; onSaved: (s: Setup) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const file = setup.files.find((f) => f.name === open);
  // Understory holds the memory: the file stays, and is not read.
  const unread = (name: string) => name === "MEMORY.md" && setup.memory === "understory";

  const save = async () => {
    if (!file) return;
    setBusy(true);
    try {
      onSaved(await api.saveAgentFile(file.name, draft));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5">
      <div className="flex flex-wrap items-center gap-1.5">
        {setup.files.map((f) => (
          <button
            key={f.name}
            onClick={() => {
              setOpen(open === f.name ? null : f.name);
              setDraft(f.content);
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
              open === f.name
                ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"
                : "bg-fg/5 text-fg-muted hover:bg-fg/10"
            }`}
          >
            <LuFileText className="h-3.5 w-3.5" />
            <span className={unread(f.name) ? "line-through decoration-fg-faint" : ""}>{f.name}</span>
          </button>
        ))}
        <span className="ml-auto text-[11px] text-fg-faint">
          {t("loaded as context when a conversation starts")}
        </span>
      </div>

      {file && (
        <div className="mt-2">
          {unread(file.name) && (
            <p role="note" className="mb-2 text-xs text-fg-muted">
              {t("Not read while Understory is the agent's memory (Settings → Add-ons → Memory). It is kept, and read again once Understory is switched off.")}
            </p>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-line bg-raised/60 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-accent/60"
          />
          <button
            onClick={save}
            disabled={busy || draft === file.content}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-2 text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40"
          >
            {busy ? (
              <LuRefreshCw className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <LuCheck className="h-4 w-4" />
            ) : null}
            {saved ? t("Saved") : t("Save")}
          </button>
        </div>
      )}
    </section>
  );
}
