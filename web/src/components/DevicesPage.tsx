import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuCheck, LuCopy, LuLaptop, LuPencil, LuPlus, LuRefreshCw, LuTrash2, LuTriangleAlert, LuX } from "react-icons/lu";
import { api, type Device, type DevicePolicy, type DevicesList, type PairingCode } from "../api";
import { copyText } from "../clipboard";
import { pollWhileVisible } from "../poll";
import { formatDateTime, msg, t } from "../i18n";
import { serverTime, sinceThen } from "../time";
import { confirmDialog } from "./ConfirmDialog";
import { DeviceApprovalCard } from "./DeviceApprovalCard";
import { DevicePolicyForm } from "./DevicePolicyForm";
import { PageHeader, Stat } from "./PageHeader";
import { ErrorBanner, LoadFailed, codeAreaCls, ghostCls, inputSmCls, primaryCls, primarySmCls } from "./SettingsUi";

/**
 * The Devices add-on's page: pairing a computer, the ones that are paired and
 * whether they are connected, what each one lets the portal do, the calls that
 * wait for the owner's answer, and removal, which cuts a device off at once.
 *
 * What a device allows is set on the device; the page shows it, and changes it
 * only where the device's owner allowed that there (portal_policy = write).
 */
export function DevicesPage() {
  const [list, setList] = useState<DevicesList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** The list was shown, and the last refresh failed: what is on the page is from before. */
  const [stale, setStale] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether a list was ever read: `list` in `load` is the first render's, which is null for as long as the page polls.
  const loaded = useRef(false);
  /** The code made here, which the portal says only once. */
  const [code, setCode] = useState<PairingCode | null>(null);
  const [pairing, setPairing] = useState(false);

  const load = () =>
    api.devices().then(
      (l) => {
        loaded.current = true;
        setFailed(null);
        setStale(null);
        setList(l);
        // Used or cancelled elsewhere, or run out: no longer a code to show.
        if (!l.pairing) setCode(null);
      },
      (e: Error) => (loaded.current ? setStale(e.message) : setFailed(e.message)),
    );

  useEffect(() => {
    void load();
    return pollWhileVisible(() => void load(), 3000);
  }, []);

  const newCode = async () => {
    setPairing(true);
    try {
      setCode(await api.newPairingCode());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPairing(false);
    }
  };

  const cancelCode = async () => {
    try {
      await api.cancelPairingCode();
      setCode(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!list) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          {failed ? <LoadFailed error={failed} onRetry={load} /> : (
            <p className="flex items-center gap-2 text-sm text-fg-subtle"><LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}</p>
          )}
        </div>
      </div>
    );
  }

  const online = list.devices.filter((d) => d.online).length;
  const waiting = list.devices.reduce((n, d) => n + d.approvals.length, 0);

  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {error && <ErrorBanner onClose={() => setError(null)}>{error}</ErrorBanner>}
        {stale && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
            <LuTriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{t("Could not refresh the list: {error}. What is shown may be out of date.", { error: stale })}</span>
          </div>
        )}
        <PageHeader
          icon={<LuLaptop />}
          title={t("Devices")}
          description={t("Your own computers, paired with the portal through the Pithagoras Sync client. A chat works on one only once you give it to that chat, and only as far as the device's own settings let it.")}
          action={
            <button type="button" className={primaryCls} disabled={pairing} onClick={() => void newCode()}>
              <LuPlus className="h-4 w-4" /> {t("Pair a device")}
            </button>
          }
        >
          <div className="mt-4 flex flex-wrap gap-2">
            <Stat value={list.devices.length} label={t("paired")} />
            <Stat value={online} label={t("connected")} tone={online ? "text-ok" : undefined} />
            {waiting > 0 && <Stat value={waiting} label={t("waiting for you")} tone="text-warn" />}
          </div>
        </PageHeader>

        <ClientDownloads />

        {code ? (
          <PairingPanel code={code} spki={list.spki} onCancel={() => void cancelCode()} onAgain={() => void newCode()} />
        ) : list.pairing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-raised/40 p-3 text-sm text-fg-muted">
            <span className="min-w-0 flex-1">
              {t("A pairing code is open until {time}. It is shown only where it was made; make a new one to see one here.", { time: formatDateTime(list.pairing.expires, { timeStyle: "short" }) })}
            </span>
            <button type="button" className={ghostCls} onClick={() => void cancelCode()}>{t("Cancel the code")}</button>
          </div>
        ) : null}

        {list.devices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-fg-subtle">
            {t("No device is paired yet. Install the Pithagoras Sync client on a computer, then press Pair a device.")}
          </p>
        ) : (
          <ul className="space-y-3">
            {list.devices.map((d) => <DeviceCard key={d.id} device={d} onChanged={load} onError={setError} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The client's releases: the newest one, and each program under a name that stays the same from release to release. */
const CLIENT_RELEASES = "https://github.com/Piggidragon/Pithagoras-Sync/releases/latest";
const CLIENT_DOWNLOADS = [
  { label: msg("Linux (x86-64)"), file: "pithagoras-sync-x86_64-linux" },
  { label: msg("Linux (ARM64)"), file: "pithagoras-sync-aarch64-linux" },
  { label: msg("Windows (x86-64)"), file: "pithagoras-sync-x86_64-windows.exe" },
];

/** Where to get the client, whether or not a device is paired yet: the newest release, one link per program. */
function ClientDownloads() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm text-fg-muted" data-testid="client-downloads">
      <span>{t("Download the client:")}</span>
      {CLIENT_DOWNLOADS.map((d) => (
        <a key={d.file} href={`${CLIENT_RELEASES}/download/${d.file}`} className="text-accent hover:underline" rel="noreferrer noopener">
          {d.label}
        </a>
      ))}
      <a href={CLIENT_RELEASES} target="_blank" className="text-accent hover:underline" rel="noreferrer noopener">
        {t("All downloads and the install guide")}
      </a>
    </div>
  );
}

/** The address the device reaches the portal at: the one this page was loaded from. */
const portalBase = () => window.location.origin;

/**
 * The code, and the link and command that carry it with the portal's address.
 * The pin goes with it only where the page itself came over TLS from the
 * portal: behind a TLS proxy the device checks the proxy's certificate against
 * the system's roots instead.
 */
function PairingPanel({ code, spki, onCancel, onAgain }: { code: PairingCode; spki: string | null; onCancel: () => void; onAgain: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const pin = window.location.protocol === "https:" ? (code.spki ?? spki) : null;
  const uri = `pithagoras-sync://pair?portal=${encodeURIComponent(portalBase())}&code=${code.code}${pin ? `&spki=${pin}` : ""}`;
  const command = `pithagoras-sync pair '${uri}'`;
  const left = Math.max(0, Math.round((Date.parse(code.expires) - now) / 1000));
  const plain = window.location.protocol === "http:" && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(window.location.hostname);
  return (
    <section aria-label={t("Pairing code")} className="rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="font-mono text-2xl tracking-[0.2em] text-fg" data-testid="pairing-code">{code.code}</p>
        <p className="text-xs text-fg-muted" role="timer">
          {left > 0 ? t("Runs out in {time}", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` }) : t("Ran out")}
        </p>
        <span className="ml-auto flex gap-1">
          {left === 0 && <button type="button" className={ghostCls} onClick={onAgain}>{t("New code")}</button>}
          <button type="button" className={ghostCls} onClick={onCancel}>{t("Cancel the code")}</button>
        </span>
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        {t("Good once, for ten minutes; ten wrong codes cancel it. On the computer, run:")}
      </p>
      <CopyLine text={command} label={t("Copy the command")} />
      <p className="mt-2 text-xs text-fg-faint">{t("The link alone, for a client that asks for it:")}</p>
      <CopyLine text={uri} label={t("Copy the link")} />
      {plain && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
          <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("This page came over plain HTTP. The client pairs only over HTTPS, or HTTP to its own machine: open the portal at its HTTPS address to pair.")}
        </p>
      )}
    </section>
  );
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex items-start gap-2 rounded-lg bg-canvas/60 p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg">{text}</code>
      <button
        type="button"
        aria-label={label}
        title={label}
        className={ghostCls}
        onClick={async () => {
          setCopied(await copyText(text));
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <LuCheck className="h-3.5 w-3.5 text-ok" /> : <LuCopy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

const MODE_LABEL: Record<string, string> = {
  ask: msg("Ask: every call asks you first"),
  folders: msg("Folders: only in the folders the device grants"),
  full: msg("Full: everything its user can do"),
};

/** The words of a second connection's alert: when, and where each connection came from. */
const whoAndWhen = (alert: NonNullable<Device["alert"]>) => ({
  time: formatDateTime(alert.at, { dateStyle: "short", timeStyle: "short" }),
  refused: where(alert.refused),
  existing: where(alert.existing),
});

function DeviceCard({ device: d, onChanged, onError }: { device: Device; onChanged: () => unknown; onError: (e: string) => void }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const info = d.info;

  const rename = async () => {
    if (renaming === null || renaming.trim() === d.name) return setRenaming(null);
    try {
      await api.renameDevice(d.id, renaming.trim());
      setRenaming(null);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t("Remove {name}?", { name: d.name }),
      message: t("Its token stops working and its connection is closed now. Chats lose it. To use the computer again, pair it again."),
      confirmLabel: t("Remove"),
      danger: true,
      deletes: true,
    });
    if (!ok) return;
    try {
      await api.removeDevice(d.id);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <li className="rounded-xl border border-line bg-raised/40 p-3" aria-label={d.name}>
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${d.online ? "bg-ok" : "bg-fg-faint"}`} />
        {renaming !== null ? (
          <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
            <input
              autoFocus
              aria-label={t("Device name")}
              className={`${inputSmCls} !w-48`}
              value={renaming}
              maxLength={24}
              pattern="[a-z0-9-]{1,24}"
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }}
            />
            <button type="submit" className={ghostCls} aria-label={t("Save")}><LuCheck className="h-3.5 w-3.5" /></button>
            <button type="button" className={ghostCls} aria-label={t("Cancel")} onClick={() => setRenaming(null)}><LuX className="h-3.5 w-3.5" /></button>
          </form>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="truncate text-sm font-medium text-fg">{d.name}</span>
            <button type="button" className={ghostCls} aria-label={t("Rename {name}", { name: d.name })} onClick={() => setRenaming(d.name)}>
              <LuPencil className="h-3 w-3" />
            </button>
          </span>
        )}
        <span className={`text-xs ${d.online ? "text-ok" : "text-fg-subtle"}`}>
          {d.online ? t("connected") : d.last_seen ? t("last seen {when}", { when: sinceThen(serverTime(d.last_seen)) || d.last_seen }) : t("never connected")}
        </span>
        <button type="button" className={`${ghostCls} hover:!text-danger`} aria-label={t("Remove {name}", { name: d.name })} onClick={() => void remove()}>
          <LuTrash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {d.alert && (
        <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg bg-warn/10 p-2 text-xs text-warn">
          <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {d.alert.replaced
              ? t("At {time} a connection from {refused} took the place of the one from {existing}, which had just been in touch. If one of them is not yours, remove the device and pair it again.", whoAndWhen(d.alert))
              : t("At {time} a connection from {refused} tried to connect with this device's token while the device was connected from {existing}, and was refused. If one of them is not yours, remove the device and pair it again.", whoAndWhen(d.alert))}
          </span>
          <button type="button" className={ghostCls} aria-label={t("Dismiss")} onClick={() => void api.clearDeviceAlert(d.id).then(onChanged, (e: Error) => onError(e.message))}>
            <LuX className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Row label={t("System")}>{info ? `${info.os_release ?? info.os} · ${info.arch}` : `${d.os} · ${d.arch}`}</Row>
        {info && <Row label={t("Runs as")}><code>{info.user}@{info.hostname}</code> · {info.shell} · {info.session}</Row>}
        {d.hello && <Row label={t("Client")}>{d.hello.clientVersion}</Row>}
        {d.remote && <Row label={t("Connected from")}>{where(d.remote)}</Row>}
        {info && (
          <Row label={t("Mode")}>
            {t(MODE_LABEL[info.mode] ?? info.mode)}
            {info.mode_expires_ms ? ` · ${t("until {time}", { time: formatDateTime(info.mode_expires_ms, { dateStyle: "short", timeStyle: "short" }) })}` : ""}
          </Row>
        )}
        {info && info.mode === "folders" && (
          <Row label={t("Folders")}>
            {info.folders.length ? info.folders.map((f) => `${f.path} (${f.access}${f.execute ? ", exec" : ""})`).join(", ") : t("none")}
          </Row>
        )}
        {info && <Row label={t("Tools")}>{info.tools.length ? info.tools.join(", ") : t("none")}</Row>}
      </dl>

      {d.sameMachine && (
        <p className="mt-2 text-xs text-fg-muted">
          {t("This is the portal's own machine and user: a chat reaches nothing here that the portal's own tools do not, so it is not offered to chats.")}
        </p>
      )}

      {d.approvals.length > 0 && (
        <section className="mt-3 space-y-2" aria-label={t("Waiting for your answer")}>
          {d.approvals.map((a) => <DeviceApprovalCard key={a.id} device={d} approval={a} onAnswered={onChanged} onError={onError} />)}
        </section>
      )}

      {d.online && d.policy && <PolicyPanel device={d} policy={d.policy} onError={onError} />}
      {d.online && !d.policy && d.hello && !d.hello.capabilities.includes("policy") && (
        <p className="mt-2 text-xs text-fg-faint">{t("The device does not share its settings with the portal (portal_policy = off).")}</p>
      )}
    </li>
  );
}

/** Where a connection came from: its address and the client's own name for itself. */
const where = (r: { address: string; userAgent: string } | null): string => (r ? `${r.address}${r.userAgent ? ` (${r.userAgent})` : ""}` : t("another connection"));

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-fg-muted">{children}</dd>
    </>
  );
}

/**
 * The device's settings: shown, and changed only where its owner set
 * portal_policy = write on the device. The form and the JSON below it are two
 * views of one draft, the text; the device checks every value and refuses
 * what it does not take, settings marked as the device's own included.
 */
function PolicyPanel({ device, policy, onError }: { device: Device; policy: DevicePolicy; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The version the draft is based on, so a change made on the device meanwhile is not overwritten.
  const base = useRef(policy.version);
  const json = useRef<HTMLDetailsElement>(null);
  const writable = policy.portal_policy === "write";
  const text = draft ?? JSON.stringify(policy.settings, null, 2);
  const parsed = (() => {
    try {
      const v: unknown = JSON.parse(text);
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as DevicePolicy["settings"]) : null;
    } catch {
      return null;
    }
  })();
  // The form shows the last settings that parsed while the text does not, disabled.
  const shown = useRef(policy.settings);
  if (parsed) shown.current = parsed;
  // Invalid text can only be fixed in the JSON, so that is opened.
  useEffect(() => {
    if (!parsed && json.current) json.current.open = true;
  }, [parsed, open]);

  const change = (value: string) => {
    if (draft === null) base.current = policy.version;
    setDraft(value);
  };

  const save = async () => {
    if (!parsed) return setProblem(t("The settings are not valid JSON."));
    setSaving(true);
    setProblem(null);
    try {
      await api.setDevicePolicy(device.id, parsed, base.current);
      setDraft(null);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(null);
    setProblem(null);
  };

  return (
    <details className="mt-3 rounded-lg border border-line" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer px-2 py-1.5 text-xs text-fg-muted">
        {writable ? t("Settings (the device lets the portal change them)") : t("Settings (shown only: the device keeps them to itself to change)")}
      </summary>
      {open && (
        <div className="space-y-2 border-t border-line p-2">
          <DevicePolicyForm
            settings={shown.current}
            deviceOnly={policy.device_only}
            locked={!writable || !parsed}
            onChange={(next) => change(JSON.stringify(next, null, 2))}
          />
          {!parsed && <p className="text-xs text-danger">{t("The settings below are not valid JSON. The form is off until they are.")}</p>}
          <details ref={json} className="rounded-lg border border-line">
            <summary className="cursor-pointer px-2 py-1.5 text-xs text-fg-muted">{t("Advanced (JSON)")}</summary>
            <div className="space-y-1 border-t border-line p-2">
              <p className="text-[11px] text-fg-faint">{t("The whole document, which also holds settings the form does not know. The form and this text show the same draft.")}</p>
              <textarea aria-label={t("Device settings")} className={`${codeAreaCls} h-64`} readOnly={!writable} value={text} onChange={(e) => change(e.target.value)} />
            </div>
          </details>
          {policy.device_only.length > 0 && (
            <p className="text-[11px] text-fg-faint">{t("Only the device changes: {names}", { names: policy.device_only.join(", ") })}</p>
          )}
          {problem && <p role="alert" className="text-xs text-danger">{problem}</p>}
          {writable && draft !== null && (
            <div className="flex gap-2">
              <button type="button" className={primarySmCls} disabled={saving || !parsed} onClick={() => void save()}>{t("Save on the device")}</button>
              <button type="button" className={ghostCls} disabled={saving} onClick={discard}>{t("Discard")}</button>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
