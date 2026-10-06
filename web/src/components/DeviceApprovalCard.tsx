import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type ApprovalChoice, type ChatDeviceApproval, type Device, type DeviceApproval, type PortalEvent } from "../api";
import { t, tp } from "../i18n";
import { pollWhileVisible, reconnectDelay } from "../poll";
import { visible, visibleParts } from "../visible";
import { ghostCls, primarySmCls } from "./SettingsUi";

const MINUTES = [15, 30, 60, 120, 240, 480];

/**
 * How long a card's buttons stay off after it appears. The next question takes the place of the one just answered, with its buttons
 * where the others were, so a second click meant for the first (a double click, an impatient one) would answer a question that
 * nobody has read. The way a browser holds a permission prompt back, for a moment.
 */
const INPUT_DELAY_MS = 700;

/** What the model or a device wrote, with every character that would hide or reorder what is read written out (see visible.ts). */
function Visible({ text, lines }: { text: string; lines?: boolean }) {
  return <>{visibleParts(text, lines).map((p, i) => (p.escaped ? <span key={i} className="rounded bg-warn/20 px-0.5 text-warn" data-escape="">{p.text}</span> : p.text))}</>;
}

/** The start of a long text, for a list that shows a line of each. */
const brief = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/**
 * A call the device holds until it is answered here, on the device, or it runs
 * out. Shown on the Devices page and in the chat the call is for (`here`), where
 * it does not point back to the chat.
 */
export function DeviceApprovalCard({ device, approval: a, here, onAnswered, onError }: { device: Pick<Device, "id" | "name">; approval: DeviceApproval; here?: boolean; onAnswered: () => unknown; onError: (e: string) => void }) {
  const choices = MINUTES.filter((m) => m <= a.max_minutes);
  const [minutes, setMinutes] = useState(choices[choices.length > 1 ? 1 : 0] ?? 0);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), INPUT_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const off = busy || !armed;
  // What was cut is only denied, whatever the list says.
  const offered = (c: ApprovalChoice) => !a.cut && a.choices.includes(c);
  const answer = async (choice: ApprovalChoice) => {
    setBusy(true);
    try {
      await api.answerDeviceApproval(device.id, a, choice, choice === "time" ? minutes : undefined);
      await onAnswered();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/5 p-2" data-testid="device-approval">
      <p className="text-xs text-fg">
        <Visible text={t("{device} asks: {tool}", { device: device.name, tool: a.tool })} />
        {a.chat && !here && <> · <Link className="text-accent hover:underline" to={`/s/${encodeURIComponent(a.chat)}`}>{t("from this chat")}</Link></>}
      </p>
      {/* Its line breaks stay (pre-wrap), and a long one scrolls, so the buttons under it stay where they are. */}
      <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg-muted" data-testid="device-approval-target"><Visible text={a.target} lines /></p>
      {a.cut && <p className="mt-1 text-[11px] text-warn" data-testid="device-approval-cut">{t("Too long to read whole, so it can only be denied.")}</p>}
      {a.reasons.length > 0 && <ul className="mt-1 list-disc pl-4 text-[11px] text-fg-subtle">{a.reasons.map((r, i) => <li key={i}><Visible text={r} /></li>)}</ul>}
      {a.preview && <pre className="mt-1 max-h-48 overflow-auto rounded bg-canvas/60 p-2 text-[11px] text-fg-muted"><Visible text={a.preview} lines /></pre>}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {offered("once") && <button type="button" disabled={off} className={primarySmCls} onClick={() => void answer("once")}>{t("Allow once")}</button>}
        {offered("chat") && <button type="button" disabled={off} className={ghostCls} onClick={() => void answer("chat")}>{t("Allow for this chat")}</button>}
        {offered("time") && choices.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <button type="button" disabled={off} className={ghostCls} onClick={() => void answer("time")}>{t("Allow for")}</button>
            <select aria-label={t("Minutes")} className="rounded border border-line bg-raised px-1 py-0.5 text-xs" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {choices.map((m) => <option key={m} value={m}>{tp(m, "{n} minute", "{n} minutes")}</option>)}
            </select>
          </span>
        )}
        <button type="button" disabled={off} className={`${ghostCls} !text-danger`} onClick={() => void answer("deny")}>{t("Deny")}</button>
      </div>
    </div>
  );
}

/** The call's own note that it waits, which is what makes the chat look at once instead of at its next turn of the poll. */
const waitsForApproval = (e: PortalEvent | undefined): boolean => {
  const text = (e?.payload as { partialResult?: { content?: { text?: unknown }[] } } | undefined)?.partialResult?.content?.[0]?.text;
  return e?.type === "tool_execution_update" && typeof text === "string" && text.startsWith("Waiting for approval on ");
};

/**
 * The questions the devices of this chat hold for it, one card at a time above
 * the composer, the oldest first, with the others as a count and a short list:
 * the owner answers where the chat is, instead of on the Devices page, and
 * decides each call on its own.
 * A question exists only while a call waits for it, so the chat asks only
 * while it runs, and anew when a call says that it waits. What the server
 * lists is what is shown: a question answered elsewhere, or whose call ended,
 * is gone from the next answer. A portal without the Devices add-on (or a chat
 * that cannot have devices) answers 404 or 409, and then nothing is asked again
 * until the add-on is switched, or a call says it waits. Any other failure is a
 * blip: the list stays as it was, and the poll goes on, a little later each time.
 */
export function ChatDeviceApprovals({ sessionId, running, events }: { sessionId: string; running: boolean; events: PortalEvent[] }) {
  const [list, setList] = useState<ChatDeviceApproval[]>([]);
  const [error, setError] = useState("");
  // The poll that is on now. An answer to a request of an earlier one (the chat was changed, or its run ended, while it was on its way) is not the list of this chat's now.
  const run = useRef<{ sessionId: string; off: boolean; failed: number; retryAt: number } | null>(null);
  // `now` asks whatever the poll's backoff says: the owner has just answered, or a call says that it waits.
  const load = useCallback(
    (now = false) => {
      const mine = run.current;
      if (!mine || mine.sessionId !== sessionId || mine.off || (!now && Date.now() < mine.retryAt)) return Promise.resolve();
      return api.chatDeviceApprovals(sessionId).then(
        (r) => {
          if (run.current !== mine) return;
          mine.failed = 0;
          setList((was) => (JSON.stringify(was) === JSON.stringify(r.approvals) ? was : r.approvals));
        },
        (e) => {
          if (run.current !== mine) return;
          if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
            mine.off = true;
            setList([]);
          } else {
            mine.retryAt = Date.now() + reconnectDelay(++mine.failed);
          }
        },
      );
    },
    [sessionId],
  );

  useEffect(() => {
    setList([]);
    setError("");
    if (!running) {
      run.current = null;
      return;
    }
    const mine = { sessionId, off: false, failed: 0, retryAt: 0 };
    run.current = mine;
    void load(true);
    const again = () => {
      mine.off = false;
      void load(true);
    };
    window.addEventListener("features-changed", again);
    const stop = pollWhileVisible(() => void load(), 3000);
    return () => {
      run.current = null;
      window.removeEventListener("features-changed", again);
      stop();
    };
  }, [sessionId, running, load]);

  const last = events[events.length - 1];
  const waiting = running && waitsForApproval(last);
  useEffect(() => {
    if (!waiting) return;
    // A call that waits for an answer means the add-on is on, whatever an earlier answer said.
    if (run.current) run.current.off = false;
    void load(true);
  }, [waiting, last?.seq, load]);

  if (!list.length) return null;
  // Oldest first, by when the device asked, so the card in front stays the same one across polls and the next moves up as it is answered.
  const queue = [...list].sort((a, b) => a.approval.created_ms - b.approval.created_ms || a.device.id.localeCompare(b.device.id) || a.approval.id - b.approval.id);
  const [{ device, approval }, ...rest] = queue;
  return (
    <section className="mx-auto mb-2 max-h-[45dvh] w-full max-w-3xl space-y-2 overflow-y-auto overscroll-contain" aria-label={t("Waiting for your answer")}>
      {/* Present before there is a second question, so a screen reader announces the count when it appears or changes. */}
      <p className="px-1 text-xs text-fg-muted" aria-live="polite" data-testid="device-approval-count" hidden={!rest.length}>
        {rest.length > 0 && t("Approval {n} of {total}", { n: 1, total: queue.length })}
      </p>
      <DeviceApprovalCard
        key={`${device.id}:${approval.id}:${approval.created_ms}`}
        device={device}
        approval={approval}
        here
        onAnswered={() => {
          setError("");
          return load(true);
        }}
        onError={(e) => {
          setError(e);
          // The question may be gone (answered elsewhere, or another one now): the list says.
          void load(true);
        }}
      />
      {rest.length > 0 && (
        <details className="px-1 text-xs text-fg-subtle" data-testid="device-approval-next">
          <summary className="cursor-pointer">{t("Waiting next")}</summary>
          <ul className="mt-1 space-y-0.5">
            {rest.map((r) => (
              <li key={`${r.device.id}:${r.approval.id}:${r.approval.created_ms}`} className="truncate" title={visible(brief(r.approval.target))}>
                {r.device.name}: {r.approval.tool} · <span className="font-mono"><Visible text={brief(r.approval.target)} /></span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="break-words rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
