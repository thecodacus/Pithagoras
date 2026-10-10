import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LuLaptop } from "react-icons/lu";
import { api, type ChatDevice, type GrantReload } from "../api";
import { t } from "../i18n";
import { pollWhileVisible } from "../poll";
import { isEscape } from "../shortcuts";
import { ghostCls, inputSmCls, Switch } from "./SettingsUi";

const WIDTH = 320;

/**
 * Which of the paired computers this chat may use, beside the browser's globe:
 * a switch for each, and the folder there that its paths and commands start
 * in. Shown only while the Devices add-on is on, in a chat of the portal's
 * own; the server says so by answering at all.
 */
export function DeviceChip({ sessionId }: { sessionId: string }) {
  const [devices, setDevices] = useState<ChatDevice[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; width: number }>();

  const load = useCallback(
    () =>
      api.chatDevices(sessionId).then(
        (r) => setDevices(r.devices),
        () => setDevices(null),
      ),
    [sessionId],
  );
  useEffect(() => {
    setDevices(null);
    setOpen(false);
    void load();
    // Switched on or off in Settings: the chip comes or goes with it.
    const again = () => void load();
    window.addEventListener("features-changed", again);
    return () => window.removeEventListener("features-changed", again);
  }, [load]);
  // Whether each is connected changes while the list is open.
  useEffect(() => (open ? pollWhileVisible(() => void load(), 5000) : undefined), [open, load]);

  // Under the chip, kept on the screen: on a phone the header's buttons are near its left edge.
  useLayoutEffect(() => {
    if (!open) return;
    const at = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(WIDTH, window.innerWidth - 32);
      setPlace({ top: r.bottom + 6, left: Math.max(16, Math.min(r.right - width, window.innerWidth - width - 16)), width });
    };
    at();
    window.addEventListener("resize", at);
    return () => window.removeEventListener("resize", at);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (isEscape(e)) {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!devices) return null;
  const granted = devices.filter((d) => d.granted);

  const said = (reload: GrantReload) => setNote(reload === "waiting" ? t("The chat takes this up once its current run is over.") : "");
  const act = async (id: string, work: () => Promise<{ reload: GrantReload }>) => {
    setBusy(id);
    setError("");
    try {
      said((await work()).reload);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("Devices")}
        aria-expanded={open}
        title={t("The paired computers this chat may use")}
        className={`panel-toggle relative flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition [&>svg]:h-3.5 [&>svg]:w-3.5 ${
          open || granted.length ? "is-open border-accent/40 bg-accent/10 text-accent" : "border-line text-fg-muted hover:bg-fg/5 hover:text-fg"
        }`}
      >
        <LuLaptop />
        {granted.length > 0 && <span className="tabular-nums" data-testid="granted-devices">{granted.length}</span>}
      </button>
      {open && place && (
        <div
          ref={panel}
          role="dialog"
          aria-label={t("Devices for this chat")}
          style={{ top: place.top, left: place.left, width: place.width }}
          className="float-in fixed z-40 rounded-xl border border-line bg-surface p-3 text-sm shadow-pop"
        >
          <p className="mb-2 text-xs text-fg-muted">
            {t("The agent acts on a device only when it names it; without one, its tools act on the server.")}
          </p>
          {devices.length === 0 ? (
            <p className="text-xs text-fg-muted">
              {t("No device is paired yet.")}{" "}
              <Link className="text-accent hover:underline" to="/devices" onClick={() => setOpen(false)}>
                {t("Pair one")}
              </Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  busy={busy === d.id}
                  onSwitch={(on) => act(d.id, () => (on ? api.grantDevice(sessionId, d.id) : api.endDeviceGrant(sessionId, d.id)))}
                  onFolder={(cwd) => act(d.id, () => api.grantDevice(sessionId, d.id, cwd))}
                />
              ))}
            </ul>
          )}
          {note && <p className="mt-2 text-xs text-fg-muted" role="status">{note}</p>}
          {error && <p className="mt-2 break-words text-xs text-danger" role="alert">{error}</p>}
        </div>
      )}
    </>
  );
}

function DeviceRow({ device: d, busy, onSwitch, onFolder }: { device: ChatDevice; busy: boolean; onSwitch: (on: boolean) => void; onFolder: (cwd: string) => void }) {
  const [folder, setFolder] = useState(d.cwd ?? "");
  useEffect(() => setFolder(d.cwd ?? ""), [d.cwd]);
  const choices = [...new Set([...(d.home && d.mode !== "folders" ? [d.home] : []), ...d.folders.map((f) => f.path)])];
  const list = `device-folders-${d.id}`;
  return (
    <li aria-label={d.name} className="rounded-lg border border-line p-2">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${d.online ? "bg-ok" : "bg-fg/20"}`} title={d.online ? t("connected") : t("not connected")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{d.name}</span>
          <span className="text-xs text-fg-faint"> · {d.os}{d.online ? "" : ` · ${t("not connected")}`}</span>
        </span>
        <Switch on={d.granted} label={t("Let this chat use {name}", { name: d.name })} disabled={busy || (!d.granted && !d.offered)} onChange={onSwitch} />
      </div>
      {d.granted && (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder.trim() && folder.trim() !== d.cwd) onFolder(folder.trim());
          }}
        >
          <input
            className={`${inputSmCls} min-w-0 flex-1 font-mono text-xs`}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            list={choices.length ? list : undefined}
            aria-label={t("Folder on {name}", { name: d.name })}
            spellCheck={false}
            disabled={busy || !d.online}
          />
          {choices.length > 0 && (
            <datalist id={list}>
              {choices.map((c) => <option key={c} value={c} />)}
            </datalist>
          )}
          <button type="submit" className={ghostCls} disabled={busy || !d.online || !folder.trim() || folder.trim() === d.cwd}>
            {t("Move")}
          </button>
        </form>
      )}
      {d.blocked ? <p className="mt-1 text-xs text-warn">{d.blocked}</p> : !d.granted && !d.offered && d.why && <p className="mt-1 text-xs text-fg-muted">{d.why}</p>}
    </li>
  );
}
