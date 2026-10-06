import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ApprovalChoice, type ChatDeviceApproval, type Device, type DeviceApproval, type PortalEvent } from "../api";
import { t, tp } from "../i18n";
import { pollWhileVisible } from "../poll";
import { ghostCls, primarySmCls } from "./SettingsUi";

const MINUTES = [15, 30, 60, 120, 240, 480];

/**
 * A call the device holds until it is answered here, on the device, or it runs
 * out. Shown on the Devices page and in the chat the call is for (`here`), where
 * it does not point back to the chat.
 */
export function DeviceApprovalCard({ device, approval: a, here, onAnswered, onError }: { device: Pick<Device, "id" | "name">; approval: DeviceApproval; here?: boolean; onAnswered: () => unknown; onError: (e: string) => void }) {
  const choices = MINUTES.filter((m) => m <= a.max_minutes);
  const [minutes, setMinutes] = useState(choices[choices.length > 1 ? 1 : 0] ?? 0);
  const [busy, setBusy] = useState(false);
  const answer = async (choice: ApprovalChoice) => {
    setBusy(true);
    try {
      await api.answerDeviceApproval(device.id, a.id, choice, choice === "time" ? minutes : undefined);
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
        {t("{device} asks: {tool}", { device: device.name, tool: a.tool })}
        {a.chat && !here && <> · <Link className="text-accent hover:underline" to={`/s/${encodeURIComponent(a.chat)}`}>{t("from this chat")}</Link></>}
      </p>
      <p className="mt-1 break-all font-mono text-xs text-fg-muted">{a.target}</p>
      {a.reasons.length > 0 && <ul className="mt-1 list-disc pl-4 text-[11px] text-fg-subtle">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {a.preview && <pre className="mt-1 max-h-48 overflow-auto rounded bg-canvas/60 p-2 text-[11px] text-fg-muted">{a.preview}</pre>}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {a.choices.includes("once") && <button type="button" disabled={busy} className={primarySmCls} onClick={() => void answer("once")}>{t("Allow once")}</button>}
        {a.choices.includes("chat") && <button type="button" disabled={busy} className={ghostCls} onClick={() => void answer("chat")}>{t("Allow for this chat")}</button>}
        {a.choices.includes("time") && choices.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <button type="button" disabled={busy} className={ghostCls} onClick={() => void answer("time")}>{t("Allow for")}</button>
            <select aria-label={t("Minutes")} className="rounded border border-line bg-raised px-1 py-0.5 text-xs" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {choices.map((m) => <option key={m} value={m}>{tp(m, "{n} minute", "{n} minutes")}</option>)}
            </select>
          </span>
        )}
        <button type="button" disabled={busy} className={`${ghostCls} !text-danger`} onClick={() => void answer("deny")}>{t("Deny")}</button>
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
 * is gone from the next answer. A portal without the Devices add-on answers
 * with an error, and then nothing is asked again until the add-on is switched.
 */
export function ChatDeviceApprovals({ sessionId, running, events }: { sessionId: string; running: boolean; events: PortalEvent[] }) {
  const [list, setList] = useState<ChatDeviceApproval[]>([]);
  const [error, setError] = useState("");
  const off = useRef(false);
  const load = useCallback(() => {
    if (off.current) return Promise.resolve();
    return api.chatDeviceApprovals(sessionId).then(
      (r) => setList((was) => (JSON.stringify(was) === JSON.stringify(r.approvals) ? was : r.approvals)),
      () => {
        off.current = true;
        setList([]);
      },
    );
  }, [sessionId]);

  useEffect(() => {
    setList([]);
    setError("");
    off.current = false;
    if (!running) return;
    void load();
    const again = () => {
      off.current = false;
      void load();
    };
    window.addEventListener("features-changed", again);
    const stop = pollWhileVisible(() => void load(), 3000);
    return () => {
      window.removeEventListener("features-changed", again);
      stop();
    };
  }, [sessionId, running, load]);

  const last = events[events.length - 1];
  const waiting = running && waitsForApproval(last);
  useEffect(() => {
    if (waiting) void load();
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
        key={`${device.id}:${approval.id}`}
        device={device}
        approval={approval}
        here
        onAnswered={() => {
          setError("");
          return load();
        }}
        onError={setError}
      />
      {rest.length > 0 && (
        <details className="px-1 text-xs text-fg-subtle" data-testid="device-approval-next">
          <summary className="cursor-pointer">{t("Waiting next")}</summary>
          <ul className="mt-1 space-y-0.5">
            {rest.map((r) => <li key={`${r.device.id}:${r.approval.id}`} className="truncate" title={r.approval.target}>{r.device.name}: {r.approval.tool} · <span className="font-mono">{r.approval.target}</span></li>)}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="break-words rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
