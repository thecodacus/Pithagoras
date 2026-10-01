import { LuMenu, LuX } from "react-icons/lu";
import { appendLiveEvent, resetLiveEvents } from "./live-events";
import { fillFrom } from "./editor-fills";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, SIGNED_OUT, type PortalEvent, type Session, type SessionStatus } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Login } from "./components/Login";
import { ConfigModal, prefetchSettings } from "./components/ConfigModal";
import { SetupAssistant, setupDismissed } from "./components/SetupAssistant";
import { load as loadCached } from "./settings-cache";
import { ExtensionDialog, type UiRequest } from "./components/ExtensionDialog";
import { SessionsPage } from "./components/SessionsPage";
import { ProjectsPage } from "./components/ProjectsPage";
import { AgentPage } from "./components/AgentPage";
import { RoutinesPage } from "./components/RoutinesPage";
import { AuditPage } from "./components/AuditPanel";
import { BrowserPage } from "./components/BrowserPage";
import { MemoryPage } from "./components/MemoryPage";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { ConfirmHost } from "./components/ConfirmDialog";
import { pollWhileVisible, reconnectDelay } from "./poll";
import { canvasConnection, canvasMessage } from "./canvas-feed";
import { APP_NAME, finishedRuns, tabTitle } from "./attention";
import { notifyIfAway, notifyState } from "./notify";
import { guardStrayDrops } from "./drop-guard";
import { usePlaces } from "./use-session-folders";
import { t, useLanguage } from "./i18n";

// Legacy routes ("session", "global") still resolve — old links stay valid.
type Tab = "general" | "extensions" | "advanced";
const LEGACY_TABS: Record<string, Tab> = { session: "general", global: "general" };

export default function App() {
  // Everything under here is drawn again in a language chosen (see i18n.ts).
  useLanguage();
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setAuthed(s.authed))
      .catch(() => setAuthed(false));
    const signedOut = () => setAuthed(false);
    window.addEventListener(SIGNED_OUT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT, signedOut);
  }, []);

  // A file dropped just beside the message box must not replace the portal.
  useEffect(() => guardStrayDrops(), []);

  if (authed === null) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>
    );
  }
  if (!authed) {
    return (
      <>
        <div className="fixed right-4 top-4 z-10">
          <ThemeSwitcher />
        </div>
        <Login onSuccess={() => setAuthed(true)} />
      </>
    );
  }

  // Every meaningful view has a URL: a session, and its settings tabs. Deep
  // links and the back button work, and the server's SPA fallback serves them.
  return (
    <>
      <ConfirmHost />
      <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/sessions" element={<Shell view="sessions" />} />
      <Route path="/projects" element={<Shell view="projects" />} />
      <Route path="/agents" element={<Shell view="agents" />} />
      {/* Where the page was while there was one agent: old links and bookmarks. */}
      <Route path="/agent" element={<Navigate to={{ pathname: "/agents", search: window.location.search }} replace />} />
      <Route path="/routines" element={<Shell view="routines" />} />
      <Route path="/browser" element={<Shell view="browser" />} />
      <Route path="/memory" element={<Shell view="memory" />} />
      <Route path="/audit" element={<Shell view="audit" />} />
      <Route path="/s/:sessionId" element={<Shell />} />
      <Route path="/s/:sessionId/settings" element={<Shell settings />} />
      <Route path="/s/:sessionId/settings/:tab" element={<Shell settings />} />
      <Route path="/settings" element={<Shell settings />} />
      <Route path="/settings/:tab" element={<Shell settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

/** Once per page load, not once per page: the Shell is drawn again on every route. */
let setupAsked = false;

function Shell({
  settings = false,
  view = "chat",
}: {
  settings?: boolean;
  view?: "chat" | "sessions" | "projects" | "agents" | "routines" | "browser" | "memory" | "audit";
}) {
  const { sessionId, tab } = useParams<{ sessionId?: string; tab?: string }>();
  const navigate = useNavigate();
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => { setMobileNav(false); }, [sessionId, view, settings]);

  // A moment after the portal has drawn: fetch what Settings opens on, and
  // offer the setup assistant while there is no model to talk to.
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (setupAsked) return;
      setupAsked = true;
      prefetchSettings();
      if (setupDismissed()) return;
      loadCached("models", api.allModels, 30_000).then((r) => r.models.length === 0 && setSetup(true), () => {});
    }, 1200);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNav(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);

  const [sessions, setSessions] = useState<Session[]>([]);
  // The task list deliberately excludes agent and routine sessions, but their
  // URLs still have to open — the Agent and Routines pages link straight to
  // them, and without this those links landed on the empty state.
  const [other, setOther] = useState<Session | null>(null);
  const [executor, setExecutor] = useState("host");
  // Asked once: the browser is optional, and the answer only changes when
  // somebody starts or stops a container.
  const [hasBrowser, setHasBrowser] = useState(false);
  // Whether Understory is the agent's memory, which is when its page is in the sidebar.
  const [hasMemory, setHasMemory] = useState(false);
  useEffect(() => {
    const ask = () => api.featureFlags().then((f) => setHasMemory(f.understory?.enabled === true)).catch(() => {});
    ask();
    // Said by Settings → Add-ons when it switches Understory, so the sidebar follows at once.
    window.addEventListener("features-changed", ask);
    return () => window.removeEventListener("features-changed", ask);
  }, []);
  const [events, setEvents] = useState<PortalEvent[]>([]);
  /** The versions of the chat's messages, as its stream says: see messageVersions on the server. */
  const [versions, setVersions] = useState<Record<number, number[]>>({});
  /** How often the chat shown was loaded again from the start: see portal_reload. */
  const loadedAgain = useRef(0);
  /** Whether anything older than what we hold is still on the server. */
  const [moreBefore, setMoreBefore] = useState(false);
  const [loadingBefore, setLoadingBefore] = useState(false);
  /**
   * Which session's replay has arrived, so it is not drawn half-built. A session
   * id rather than a flag: the first render after switching still holds the
   * previous session's events, and must not show them under the new title.
   */
  const [loadedSession, setLoadedSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uiQueue, setUiQueue] = useState<UiRequest[]>([]);
  const esRef = useRef<EventSource | null>(null);
  /** Connection attempts to the open conversation that have failed in a row. */
  const [failures, setFailures] = useState(0);

  /**
   * Whether the chats have been asked for yet, and have come or failed to: the
   * projects are asked for then, not before and again once the chats are there
   * — and not never, when the chats cannot be had and the projects can.
   */
  const [sessionsAsked, setSessionsAsked] = useState(false);
  const { places, reload: reloadPlaces } = usePlaces(sessions, sessionsAsked);

  /** A chat started in `workspace`, or in Home without one, and opened. */
  const startChat = async (workspace?: string) => {
    const s = await api.createSession(workspace);
    await refreshSessions();
    setMobileNav(false);
    navigate(`/s/${s.id}`);
  };

  const refreshSessions = useCallback(async () => {
    const r = await api.sessions();
    setSessions(r.sessions);
    setSessionsAsked(true);
    setExecutor(r.executor);
    return r.sessions;
  }, []);

  useEffect(() => {
    refreshSessions()
      .then((list) => {
        // Landing on "/" opens the most recent session — but only "/". The
        // Sessions and Agents pages have no sessionId either, and without the
        // view check they were redirected away the moment they loaded.
        if (!sessionId && !settings && view === "chat" && list[0]) {
          navigate(`/s/${list[0].id}`, { replace: true });
        }
      })
      .catch((e) => {
        setSessionsAsked(true);
        setError(String(e));
      });
    api
      .browser()
      // Whether one is wired up, not whether anyone has been given it: the
      // browser is on by default now, so "somebody has it" is not a sign that
      // the add-on is there, and a tool name lingering in the catalogue would
      // keep the nav after the add-on was removed.
      .then((b) => setHasBrowser(b.running || b.configured || b.routines.length > 0))
      .catch(() => setHasBrowser(false));
    return pollWhileVisible(() => refreshSessions().catch(() => {}), 5000);
  }, [refreshSessions, sessionId, settings, view, navigate]);

  // Replay-then-tail for whichever session is in the URL.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    setVersions({});
    setMoreBefore(false);
    setUiQueue([]);
    setLoadedSession(null);
    setFailures(0);
    if (!sessionId) return;

    let cancelled = false;
    let seq = 0;
    let failed = 0;
    // Loading the chat again, from the start: what arrives replaces what is
    // held, once it has all come. See portal_reload.
    let replacing = false;
    // How often the chat's events were put back under seqs this page had read
    // past, as its stream last said: see bumpReloads on the server.
    let reloads: number | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (cancelled) return;
      const fresh = seq === 0;
      const es = new EventSource(`/api/sessions/${sessionId}/events?since=${seq}`);
      /** Reads the chat again from the start, keeping what is shown until it has all come. */
      const reload = () => {
        es.close();
        seq = 0;
        replacing = true;
        connect();
      };
      esRef.current = es;
      // The canvas panel is drawn before the stream is up: it waits for the
      // list the stream sends first, rather than asking for it as well.
      canvasConnection(sessionId, "connecting");
      es.onopen = () => {
        failed = 0;
        setFailures(0);
        canvasConnection(sessionId, "up");
      };
      // A count other than the last one seen: events came back while this page
      // was away, under seqs it had read past, and going on from its cursor
      // would never show them. A stream reading from the start has them all.
      es.addEventListener("reloads", (m) => {
        const now = (JSON.parse((m as MessageEvent).data) as { reloads: number }).reloads;
        const missed = reloads !== undefined && now !== reloads && !fresh;
        reloads = now;
        if (missed) reload();
      });
      es.addEventListener("versions", (m) => setVersions((JSON.parse((m as MessageEvent).data) as { versions: Record<number, number[]> }).versions));
      es.addEventListener("live-reset", () => setEvents(resetLiveEvents));
      es.addEventListener("canvas", (m) => canvasMessage(sessionId, JSON.parse((m as MessageEvent).data)));
      // Until it has caught up, what arrives is history being replayed. It is
      // gathered and applied in one go: drawing the conversation once per event
      // is what made a long one open at the top, build downwards over seconds and
      // then jump to the end.
      let replay: PortalEvent[] | null = [];
      // Applied straight from the event, not by re-fetching: the round trip
      // is what made the Stop button appear a beat late, or not at all when
      // the reply came back before the list did.
      const applyStatus = (ev: PortalEvent) => {
        if (ev.type !== "portal_status") return;
        const status = (ev.payload as { status?: SessionStatus }).status;
        if (status) {
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? { ...s, status } : s)),
          );
          // An agent or routine session is not in that list at all — it is
          // fetched once, on its own. Without this it kept whatever status
          // the fetch happened to catch, so a chat either never started
          // working or never stopped, and the activity line ran forever.
          setOther((prev) => (prev?.id === sessionId ? { ...prev, status } : prev));
        }
        refreshSessions().catch(() => {});
      };
      // Dialogs an extension is blocking on. notify/setStatus/setWidget are
      // one-way and must not open a modal.
      const applyDialog = (ev: PortalEvent) => {
        if (ev.type === "extension_ui_request") {
          const req = ev.payload as UiRequest;
          if (["select", "confirm", "input", "editor"].includes(req.method)) {
            setUiQueue((q) => (q.some((x) => x.id === req.id) ? q : [...q, req]));
          }
        }
        if (ev.type === "extension_ui_cancel") {
          const id = (ev.payload as { id: string }).id;
          setUiQueue((q) => q.filter((x) => x.id !== id));
        }
      };
      const flush = () => {
        const batch = replay;
        replay = null;
        if (!batch) return;
        if (replacing) {
          replacing = false;
          // What was being fetched from above the old list belongs to it.
          loadedAgain.current++;
          setEvents(batch.reduce(appendLiveEvent, [] as PortalEvent[]));
        } else if (batch.length) setEvents((prev) => batch.reduce(appendLiveEvent, prev));
        if (!batch.length) return;
        // Only where the session ended up is news; the statuses it passed
        // through on the way were each a request for the session list.
        const last = [...batch].reverse().find((e) => e.type === "portal_status");
        if (last) applyStatus(last);
        batch.forEach(applyDialog);
        for (const ev of batch) fillFrom(sessionId, ev);
      };
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        // A message was taken out of the conversation: drop what it covered,
        // rather than reloading everything to find out what is left. While the
        // replay is still being gathered that buffer is where they are, so it
        // is filtered instead of the rendered list.
        if (ev.type === "portal_removed") {
          // `also` and `kept`: messages sent into a run go with the stretch the
          // agent read them in, not the one whose seq range they were sent in.
          const { from, to, also = [], kept = [], reloads: now } = ev.payload as { from: number; to: number | null; also?: number[]; kept?: number[]; reloads?: number };
          // Heard, so not missed: the count this brings is not a reason to load again.
          if (now !== undefined) reloads = now;
          const covered = (at: number) =>
            also.includes(at) || (at >= from && (to == null || at < to) && !kept.includes(at));
          if (replay) replay = replay.filter((e) => !covered(e.seq));
          else setEvents((prev) => prev.filter((e) => !covered(e.seq)));
          return;
        }
        // Another version of a message was brought back, or an edit undone:
        // events came back under seqs this stream has read past, so it reads
        // the chat again from the start.
        if (ev.type === "portal_versions") {
          setVersions((ev.payload as { versions: Record<number, number[]> }).versions);
          return;
        }
        if (ev.type === "portal_reload") {
          reloads = (ev.payload as { reloads?: number }).reloads ?? reloads;
          reload();
          return;
        }
        // Live-only events (dialogs) use a negative seq and must not move the
        // resume cursor, or reconnecting would skip real history.
        if (ev.seq > 0) seq = ev.seq;
        if (replay) {
          replay.push(ev);
          return;
        }
        setEvents((prev) => appendLiveEvent(prev, ev));
        applyStatus(ev);
        applyDialog(ev);
        fillFrom(sessionId, ev);
      };
      es.addEventListener("caught-up", () => {
        flush();
        setLoadedSession(sessionId);
        // Only now do we know where the replayed window starts, and therefore
        // whether the conversation continues above it.
        setEvents((prev) => {
          const oldest = prev.find((e) => e.seq > 0)?.seq;
          if (oldest === undefined) return prev;
          api
            .olderEvents(sessionId, oldest, 1)
            .then((r) => setMoreBefore(r.events.length > 0))
            .catch(() => {});
          return prev;
        });
      });
      es.onerror = () => {
        // Keep what arrived: the resume cursor has already moved past it.
        // Unless the chat is being read again: part of it would replace all
        // of what is shown, so that stays, and the reading starts over.
        if (replacing) {
          replay = null;
          seq = 0;
        } else flush();
        es.close();
        canvasConnection(sessionId, "down");
        failed += 1;
        setFailures(failed);
        retry = setTimeout(connect, reconnectDelay(failed));
      };
    };
    connect();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      esRef.current?.close();
      canvasConnection(sessionId, "down");
    };
  }, [sessionId, refreshSessions]);

  const listed = sessions.find((s) => s.id === sessionId) ?? null;

  useEffect(() => {
    if (!sessionId || listed) return setOther(null);
    let cancelled = false;
    const load = () =>
      api
        .session(sessionId)
        .then((s) => !cancelled && setOther(s))
        .catch(() => !cancelled && setOther(null));
    load();
    // The same five seconds the task list gets. Events keep this current
    // between ticks; the poll is what stops a dropped one from stranding the
    // session on a status it left long ago.
    const stop = pollWhileVisible(load, 5000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [sessionId, listed]);

  const active = listed ?? (other?.id === sessionId ? other : null);

  // What the tab says while you are looking at something else, and — if you
  // asked for them — a notification when a chat you left running is done.
  const waiting = Boolean(active && uiQueue[0]);
  const lang = useLanguage();
  useEffect(() => {
    document.title = tabTitle(active ? { title: active.title, status: active.status } : null, waiting);
    return () => {
      document.title = APP_NAME;
    };
  }, [active?.title, active?.status, waiting, lang]);

  // The list stops being polled while the page is hidden, but a chat left
  // running there can only be seen finishing through it — the open one has its
  // stream, the rest do not. So while someone asked to be told and something
  // is running, a hidden page keeps asking, more slowly.
  const anyRunning = sessions.some((s) => s.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      if (document.hidden && notifyState() === "on") refreshSessions().catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [anyRunning, refreshSessions]);

  const lastStatus = useRef(new Map<string, SessionStatus>());
  useEffect(() => {
    for (const s of finishedRuns(lastStatus.current, sessions)) {
      notifyIfAway(s.title, s.status === "error" ? t("Stopped with an error") : t("Finished"), s.id, () =>
        navigate(`/s/${s.id}`),
      );
    }
    lastStatus.current = new Map(sessions.map((s) => [s.id, s.status]));
  }, [sessions]);

  const askedId = active ? uiQueue[0]?.id : undefined;
  useEffect(() => {
    if (!active || !askedId) return;
    notifyIfAway(active.title, t("Waiting for your answer"), `ask-${active.id}`, () => navigate(`/s/${active.id}`));
  }, [askedId]);

  return (
    <div data-fits-keyboard className="flex h-[calc(100dvh-var(--keyboard,0px))] min-h-0 overflow-hidden bg-canvas">
      {mobileNav && <button aria-label={t("Dismiss navigation")} onClick={() => setMobileNav(false)} className="ui-backdrop fixed inset-0 z-40 bg-black/50 md:hidden" />}
      <div id="mobile-navigation" className={`${mobileNav ? "mobile-drawer fixed inset-y-0 left-0 z-50 flex" : "hidden"} h-full shrink-0 md:static md:z-auto md:flex`}>
      {mobileNav && <button type="button" aria-label={t("Close navigation")} onClick={() => setMobileNav(false)} className="absolute right-2 top-3 z-20 rounded-lg p-2 text-fg md:hidden"><LuX size={20}/></button>}
      <Sidebar
        forceExpanded={mobileNav}
        sessions={sessions}
        executor={executor}
        activeId={sessionId ?? null}
        view={view}
        hasBrowser={hasBrowser}
        hasMemory={hasMemory}
        places={places}
        onNavigate={(to) => { setMobileNav(false); navigate(`/${to}`); }}
        onOpenFolder={(key) => { setMobileNav(false); navigate(`/sessions?folder=${encodeURIComponent(key)}`); }}
        onSelect={(id) => { setMobileNav(false); navigate(`/s/${id}`); }}
        onNewChat={startChat}
        onDelete={async (id) => {
          await api.deleteSession(id);
          const list = await refreshSessions();
          if (sessionId === id) navigate(list[0] ? `/s/${list[0].id}` : "/", { replace: true });
        }}
        onRename={async (id, title) => {
          await api.renameSession(id, title);
          refreshSessions();
        }}
        onPin={async (id, pinned) => {
          await api.pinSession(id, pinned);
          refreshSessions();
        }}
        onOpenSettings={() =>
          navigate(sessionId ? `/s/${sessionId}/settings/general` : "/settings/general")
        }
      />

      </div>
      <main className="app-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* In a chat the chat's own header has the menu button, and this bar
            would only repeat its title; in voice mode that header is gone. */}
        <header className="app-mobile-bar flex shrink-0 items-center gap-3 border-b border-line px-3 py-2 md:hidden">
          <button type="button" aria-label={t("Open navigation")} aria-expanded={mobileNav} aria-controls="mobile-navigation" onClick={() => setMobileNav(true)} className="rounded-lg p-2 text-fg hover:bg-fg/10"><LuMenu size={20}/></button>
          <span className="truncate text-sm text-fg">{active?.title || "Pithagoras"}</span>
        </header>
        {error && <div className="bg-danger/10 px-4 py-2 text-sm text-danger">{error}</div>}
        {/* Not for the first miss: a server restarting, or a wifi that blinked,
            is back before it can be read. Two in a row is an outage. */}
        {sessionId && failures >= 2 && (
          <div role="status" className="bg-warn/10 px-4 py-2 text-sm text-warn">
            {t("Lost the connection to the portal — trying again. What is shown may be out of date.")}
          </div>
        )}
        {/* One page failing to draw takes down that page, not the portal. */}
        <ErrorBoundary resetKey={`${view}:${sessionId ?? ""}`}>
        {view === "sessions" ? (
          <SessionsPage
            sessions={sessions}
            places={places}
            onSelect={(id) => navigate(`/s/${id}`)}
            onNewChat={startChat}
            onDelete={async (id) => {
              await api.deleteSession(id);
              await refreshSessions();
            }}
            onPin={async (id, pinned) => {
              await api.pinSession(id, pinned);
              refreshSessions();
            }}
            onRename={async (id, title) => {
              await api.renameSession(id, title);
              // Saved by now, and shown so, whether or not the list then loads:
              // a list that fails to load is not a rename that failed.
              setSessions((all) => all.map((s) => (s.id === id ? { ...s, title } : s)));
              await refreshSessions().catch(() => {});
            }}
          />
        ) : view === "projects" ? (
          <ProjectsPage
            sessions={sessions}
            onOpenChat={(id) => navigate(`/s/${id}`)}
            onNewChat={async (workspace) => {
              const s = await api.createSession(workspace);
              await refreshSessions();
              navigate(`/s/${s.id}`);
            }}
            onChanged={() => {
              refreshSessions();
              reloadPlaces();
            }}
          />
        ) : view === "agents" ? (
          <AgentPage onSelect={(id) => navigate(`/s/${id}`)} />
        ) : view === "routines" ? (
          <RoutinesPage onOpenSession={(id) => navigate(`/s/${id}`)} />
        ) : view === "browser" ? (
          <BrowserPage onOpenSession={(id) => navigate(`/s/${id}`)} />
        ) : view === "memory" ? (
          <MemoryPage />
        ) : view === "audit" ? (
          <AuditPage />
        ) : active ? (
          <Chat
            session={active}
            events={loadedSession === active.id ? events : []}
            loading={loadedSession !== active.id}
            hasEarlier={loadedSession === active.id && moreBefore}
            loadingEarlier={loadingBefore}
            onLoadEarlier={async () => {
              const oldest = events.find((e) => e.seq > 0)?.seq;
              if (!oldest || loadingBefore) return;
              setLoadingBefore(true);
              const asked = loadedAgain.current;
              try {
                const r = await api.olderEvents(active.id, oldest);
                // Loaded again meanwhile: what is above the new list is another question.
                if (asked !== loadedAgain.current) return;
                setEvents((prev) => [...r.events, ...prev]);
                setMoreBefore(r.more);
              } catch {
                // Leave the button where it is; trying again is free.
              } finally {
                setLoadingBefore(false);
              }
            }}
            onSend={async (msg, options) => {
              await api.prompt(active.id, msg, options);
              refreshSessions();
            }}
            versions={versions}
            onEditMessage={async (seq, message) => {
              await api.editMessage(active.id, seq, message);
              refreshSessions();
            }}
            onDeleteMessage={async (seq) => {
              await api.deleteMessage(active.id, seq);
            }}
            onAbort={async () => {
              await api.abort(active.id);
              refreshSessions();
            }}
            onRename={async (title) => {
              await api.renameSession(active.id, title);
              await refreshSessions();
            }}
            onOpenNavigation={() => setMobileNav(true)}
            onClientCommand={async (name, args) => {
              if (name === "settings") {
                navigate(`/s/${active.id}/settings/general`);
              } else if (name === "new" || name === "clear") {
                // A fresh chat in the same project, or in Home.
                const s = await api.createSession(active.workspace);
                await refreshSessions();
                setMobileNav(false);
                navigate(`/s/${s.id}`);
              } else if (name === "name" && args.trim()) {
                await api.renameSession(active.id, args.trim());
                refreshSessions();
              }
            }}
          />
        ) : (
          <EmptyState hasSessions={sessions.length > 0} />
        )}
        </ErrorBoundary>
      </main>

      {active && uiQueue[0] && (
        <ExtensionDialog
          sessionId={active.id}
          request={uiQueue[0]}
          onDone={() => setUiQueue((q) => q.slice(1))}
        />
      )}

      {settings && (
        <ConfigModal
          initialTab={LEGACY_TABS[tab ?? ""] ?? (tab as Tab) ?? "general"}
          onClose={() => navigate(active ? `/s/${active.id}` : "/")}
          onSetup={() => {
            navigate(active ? `/s/${active.id}` : "/");
            setSetup(true);
          }}
        />
      )}

      {setup && (
        <SetupAssistant
          onClose={() => setSetup(false)}
          onStartChat={async () => {
            const s = await api.createSession();
            await refreshSessions();
            navigate(`/s/${s.id}`);
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ hasSessions }: { hasSessions: boolean }) {
  return (
    <div className="chat-empty flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <img src="/icon-192.png" alt="" draggable={false} className="chat-empty-mark mb-2 h-12 w-12 object-contain" />
      <p className="text-sm text-fg-muted">
        {/* On a phone the list is behind the menu, not on the left. */}
        {hasSessions ? t("Pick a session from the list.") : t("Start a session to get going.")}
      </p>
      <p className="max-w-xs text-xs text-fg-faint">
        {t("Give it a task and close the tab — it keeps working, and picks up where it left off when you come back.")}
      </p>
    </div>
  );
}
