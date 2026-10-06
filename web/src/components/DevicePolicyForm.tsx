import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { LuPlus, LuX } from "react-icons/lu";
import { msg, t } from "../i18n";
import { Segments, ghostCls, inputSmCls } from "./SettingsUi";

/**
 * A device's settings as a form, over the same document the JSON below it holds:
 * a control reads its setting out of `settings` and hands back the whole document
 * with that one setting changed, so every key the form does not know (a newer
 * client's) goes through untouched. A setting the document leaves out shows the
 * device's default, and is written only once it is changed.
 *
 * What each setting means is in the Sync client's docs/permissions.md; the labels
 * here say it in plain words. The device checks every value, so the limits shown
 * are hints, not rules.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value at a dotted path (`policy.folders.0.path`); anything in the way that is not a container ends it. */
function getAt(root: unknown, path: string): unknown {
  let at = root;
  for (const key of path.split(".")) {
    if (Array.isArray(at)) at = at[Number(key)];
    else if (isObj(at)) at = at[key];
    else return undefined;
  }
  return at;
}

/** A copy of the document with the value at the path set (`undefined` takes the key out), made on the way down. */
function setAt(node: unknown, keys: string[], value: unknown): unknown {
  const [key, ...rest] = keys;
  const next = rest.length ? setAt(Array.isArray(node) ? node[Number(key)] : isObj(node) ? node[key] : undefined, rest, value) : value;
  if (Array.isArray(node)) {
    const copy = [...node];
    copy[Number(key)] = next;
    return copy;
  }
  const copy = { ...(isObj(node) ? node : {}) };
  if (next === undefined) delete copy[key];
  else copy[key] = next;
  return copy;
}

interface Form {
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  /** Whether only the device changes this setting (the device lists it as its own). */
  only: (path: string) => boolean;
}
const FormContext = createContext<Form>({ get: () => undefined, set: () => {}, only: () => false });
const useForm = () => useContext(FormContext);

const MODES = [
  { id: "ask", label: msg("Ask") },
  { id: "folders", label: msg("Folders") },
  { id: "full", label: msg("Full") },
];
const SHELLS = [
  { id: "landlock", label: msg("Confined (Landlock)") },
  { id: "prompt", label: msg("Every command asks") },
  { id: "unconfined", label: msg("Unconfined") },
];
const ACCESS = [
  { id: "ro", label: msg("Read only") },
  { id: "rw", label: msg("Read and write") },
];
const TIMEOUTS = [
  { id: "deny", label: msg("Deny it") },
  { id: "allow", label: msg("Allow it once") },
];
const ELEVATION = [
  { id: "off", label: msg("Off") },
  { id: "sudo", label: msg("sudo") },
];
const STORAGE = [
  { id: "memory", label: msg("Only in memory") },
  { id: "file", label: msg("In a file") },
];
const TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
const DAYS = [
  { id: "mon", label: msg("Mon") },
  { id: "tue", label: msg("Tue") },
  { id: "wed", label: msg("Wed") },
  { id: "thu", label: msg("Thu") },
  { id: "fri", label: msg("Fri") },
  { id: "sat", label: msg("Sat") },
  { id: "sun", label: msg("Sun") },
];
const RIGHTS = [
  { id: "r", label: msg("read") },
  { id: "w", label: msg("write") },
  { id: "x", label: msg("run") },
];
const RULES = [
  { id: "exact", label: msg("is exactly") },
  { id: "prefix", label: msg("starts with") },
  { id: "glob", label: msg("matches the pattern") },
  { id: "regex", label: msg("matches the regular expression") },
];

export function DevicePolicyForm({ settings, deviceOnly, locked, onChange }: { settings: Obj; deviceOnly: string[]; locked: boolean; onChange: (next: Obj) => void }) {
  const form: Form = {
    get: (path) => getAt(settings, path),
    set: (path, value) => onChange(setAt(settings, path.split("."), value) as Obj),
    only: (path) => deviceOnly.some((d) => path === d || path.startsWith(`${d}.`)),
  };
  return (
    <FormContext.Provider value={form}>
      {/* A fieldset's own minimum width is its content's: without min-w-0 a long path pushes the page sideways on a phone. */}
      <fieldset disabled={locked} className="m-0 min-w-0 space-y-4 border-0 p-0" aria-label={t("Device settings form")}>
        <Section title={t("Mode and folders")}>
          <Pick path="policy.mode" label={t("Mode")} def="ask" options={MODES} hint={t("Ask: every call asks first. Folders: file calls only inside the folders below, commands only where a folder lets them run. Full: everything the device's user can do, with the protections below still on.")} />
          <ObjList path="policy.folders" label={t("Folders")} add={t("Add a folder")} hint={t("The folders Folders mode allows.")} blank={() => ({ path: "", access: "ro", execute: false })}>
            {(at) => (
              <>
                <Text path={at("path")} label={t("Path")} placeholder="/home/user/project" hint={t("An absolute path on the device.")} />
                <Pick path={at("access")} label={t("Access")} def="ro" options={ACCESS} />
                <Check path={at("execute")} label={t("Commands may run here")} hint={t("Lets commands use this folder as their working folder and run programs from it.")} />
              </>
            )}
          </ObjList>
          <Pick path="policy.folders_shell" label={t("How commands run in Folders mode")} def="landlock" options={SHELLS} hint={t("Confined: writable only inside the read-and-write folders, where the device's system can do that; elsewhere every command asks. Unconfined: with all of the user's rights, only risky commands ask.")} />
          <ObjList path="policy.allow_globs" label={t("More files the file tools may reach")} add={t("Add a pattern")} hint={t("Patterns for files outside the folders that Folders mode lets the file tools use, such as ~/notes/*.md. Commands are not affected.")} blank={() => ({ glob: "", access: "ro" })}>
            {(at) => (
              <>
                <Text path={at("glob")} label={t("Pattern")} placeholder="~/notes/*.md" />
                <Pick path={at("access")} label={t("Access")} def="ro" options={ACCESS} />
              </>
            )}
          </ObjList>
        </Section>
        <Section title={t("Full mode")}>
          <Num path="policy.full.expiry_hours" label={t("Hours until Full falls back to Ask")} def={8} min={0} hint={t("0 means never.")} />
          <Check path="policy.full.protected_paths" label={t("Protected paths still ask")} def />
          <Check path="policy.full.pattern_prompts" label={t("Risky commands still ask")} def hint={t("sudo and the like, git push, a download piped into a shell, rm -r outside the working folder.")} />
          <Check path="policy.full.taint_prompts" label={t("Calls from a chat that has seen untrusted content still ask")} def />
        </Section>
        <Section title={t("Tools")}>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
            {TOOLS.map((tool) => (
              <Check key={tool} path={`policy.tools.${tool}`} label={tool} def code />
            ))}
          </div>
          <p className="text-[11px] text-fg-faint">{t("A tool that is off is not offered to the agent on this device.")}</p>
        </Section>
        <Section title={t("Refused everywhere")}>
          <ObjList path="policy.deny" label={t("Paths and patterns")} add={t("Add a path")} hint={t("Refused in every mode: a path with everything below it, or a pattern. Patterns bind the file tools only.")} blank={() => ({ path: "", rights: "rwx" })}>
            {(at) => (
              <>
                <Text path={at("path")} label={t("Path or pattern")} placeholder="~/private" />
                <Rights path={at("rights")} />
              </>
            )}
          </ObjList>
        </Section>
        <Section title={t("Commands")}>
          <RuleList path="policy.commands.deny" label={t("Refused")} hint={t("Commands containing a match are refused.")} />
          <RuleList path="policy.commands.allow" label={t("Only these may run")} hint={t("When there is any, only simple commands matching one of these run at all.")} />
          <RuleList path="policy.commands.always_ask" label={t("Always ask")} hint={t("Commands containing a match ask, in every mode.")} />
          <RuleList path="policy.commands.never_ask" label={t("Never ask")} hint={t("Simple commands matching one skip the mode's questions, not the deny rules or Folders' limits.")} />
          <p className="text-[11px] text-fg-faint">{t("These rules filter the text the portal sends; they are not a sandbox.")}</p>
        </Section>
        <Section title={t("Hours")}>
          <Hours />
        </Section>
        <Section title={t("Protected paths")}>
          <Strings path="policy.protected.extra" label={t("More protected paths")} add={t("Add a path")} hint={t("Absolute, or starting with ~/")} />
          <Strings path="policy.protected.allow" label={t("Built-in protected paths released")} add={t("Add a path")} hint={t("Built-in protected paths the owner lets through, by name.")} />
          <Strings path="policy.protected.tool_config" label={t("Names that make writes ask")} add={t("Add a name")} hint={t("A single file or folder name; a write anywhere below it asks.")} />
        </Section>
        <Section title={t("Approvals")}>
          <Num path="policy.approvals.timeout_secs" label={t("Seconds a call waits for an answer")} def={120} min={1} max={3600} hint={t("1 to 3600.")} />
          <Pick path="policy.approvals.on_timeout" label={t("An approval nobody answers is")} def="deny" options={TIMEOUTS} />
          <Num path="policy.approvals.remember_minutes" label={t("Minutes \"allow for this chat\" lasts")} def={60} min={0} max={10080} hint={t("0 means until the chat's grant ends. At most 10080 (a week).")} />
          <Num path="policy.approvals.max_minutes" label={t("The longest \"allow for a time\" answer, in minutes")} def={480} min={0} max={10080} hint={t("At most 10080 (a week).")} />
          <Check path="policy.approvals.desktop_notifications" label={t("Also show approvals as desktop notifications")} />
        </Section>
        <Section title={t("Root and elevation")}>
          <Check path="policy.privilege.allow_root" label={t("The client may run as root or an elevated administrator")} />
          <Pick path="policy.privilege.elevation" label={t("Elevation")} def="off" options={ELEVATION} hint={t("sudo: a command that starts with sudo runs as root, with the password stored on the device. Such a command always asks. Linux only.")} />
          <Text path="policy.privilege.sudo_path" label={t("The sudo the client runs")} placeholder="/usr/bin/sudo" />
          <Pick path="policy.privilege.secret_storage" label={t("Where the elevation password is kept")} def="memory" options={STORAGE} />
        </Section>
        <Section title={t("Running commands")}>
          <Text path="exec.shell" label={t("Shell")} nullable placeholder={t("The device's default")} hint={t("The shell the bash tool runs: an absolute path.")} />
          <Strings path="exec.env_passthrough" label={t("Environment variables commands also get")} add={t("Add a variable")} hint={t("Beyond the built-in list (PATH, HOME, LANG and a few more).")} />
          <Num path="exec.max_running" label={t("Most commands running at once")} def={16} min={1} />
          <Num path="exec.max_timeout_secs" label={t("The longest a command may run, in seconds")} def={14400} min={1} />
          <Num path="exec.output_cap_bytes" label={t("Output kept per command, in bytes")} def={16777216} min={1} hint={t("Output beyond this is dropped.")} />
        </Section>
      </fieldset>
    </FormContext.Provider>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h4 className="border-b border-line pb-0.5 text-xs font-medium text-fg">{title}</h4>
      {children}
    </section>
  );
}

const OnlyTag = () => <span className="ml-1.5 text-[11px] text-warn">{t("only the device changes this")}</span>;

/** A labelled setting; a fieldset, so that disabling it disables whatever control it holds. */
function Item({ path, label, hint, children }: { path: string; label: string; hint?: string; children: ReactNode }) {
  const only = useForm().only(path);
  return (
    <fieldset disabled={only} className={`m-0 min-w-0 border-0 p-0 ${only ? "opacity-60" : ""}`}>
      <div className="text-xs text-fg-muted">
        {label}
        {only && <OnlyTag />}
      </div>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-fg-faint">{hint}</p>}
    </fieldset>
  );
}

function Check({ path, label, hint, def = false, code }: { path: string; label: string; hint?: string; def?: boolean; code?: boolean }) {
  const form = useForm();
  const v = form.get(path);
  const only = form.only(path);
  return (
    <label className={`flex items-start gap-2 text-xs text-fg-muted ${only ? "opacity-60" : ""}`}>
      <input type="checkbox" aria-label={label} className="mt-0.5" disabled={only} checked={typeof v === "boolean" ? v : def} onChange={(e) => form.set(path, e.target.checked)} />
      <span className="min-w-0">
        {code ? <code>{label}</code> : label}
        {only && <OnlyTag />}
        {hint && <span className="block text-[11px] text-fg-faint">{hint}</span>}
      </span>
    </label>
  );
}

function Pick({ path, label, def, options, hint }: { path: string; label: string; def: string; options: { id: string; label: string }[]; hint?: string }) {
  const form = useForm();
  const v = form.get(path);
  return (
    <Item path={path} label={label} hint={hint}>
      <Segments label={label} value={typeof v === "string" ? v : def} options={options} onChange={(id) => form.set(path, id)} />
    </Item>
  );
}

function Text({ path, label, hint, placeholder, nullable }: { path: string; label: string; hint?: string; placeholder?: string; nullable?: boolean }) {
  const form = useForm();
  const v = form.get(path);
  return (
    <Item path={path} label={label} hint={hint}>
      <input
        aria-label={label}
        className={`${inputSmCls} font-mono text-xs`}
        placeholder={placeholder}
        value={typeof v === "string" ? v : ""}
        onChange={(e) => form.set(path, nullable && e.target.value === "" ? null : e.target.value)}
      />
    </Item>
  );
}

/**
 * A whole number. What is typed is kept as text and handed on only while it is a
 * number, so that a field being cleared to be retyped does not put 0 in the document.
 */
function NumInput({ value, onChange, label, min, max, nullable, placeholder }: { value: number | null; onChange: (n: number | null) => void; label: string; min?: number; max?: number; nullable?: boolean; placeholder?: string }) {
  const parse = (s: string) => (s.trim() === "" ? (nullable ? null : NaN) : /^-?\d+$/.test(s.trim()) && Number.isSafeInteger(Number(s)) && (min === undefined || min < 0 || Number(s) >= 0) ? Number(s) : NaN);
  const [text, setText] = useState(value === null ? "" : String(value));
  // Another change to the setting (the JSON, a discard) shows; what is being typed is left while it still says the same.
  useEffect(() => setText((cur) => (parse(cur) === value ? cur : value === null ? "" : String(value))), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      aria-invalid={Number.isNaN(parse(text))}
      className={`${inputSmCls} !w-40`}
      min={min}
      max={max}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (!Number.isNaN(n)) onChange(n);
      }}
    />
  );
}

function Num({ path, label, hint, def, min, max, nullable }: { path: string; label: string; hint?: string; def?: number; min?: number; max?: number; nullable?: boolean }) {
  const form = useForm();
  const v = form.get(path);
  return (
    <Item path={path} label={label} hint={hint}>
      <NumInput label={label} min={min} max={max} nullable={nullable} value={typeof v === "number" ? v : (def ?? null)} onChange={(n) => form.set(path, n)} />
    </Item>
  );
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const removeCls = `${ghostCls} shrink-0 !px-1.5`;

/** An editable list: `children` draws one entry, given the dotted path of each of its keys. */
function ObjList({ path, label, hint, add, blank, children }: { path: string; label: string; hint?: string; add: string; blank: () => unknown; children: (at: (key: string) => string, i: number) => ReactNode }) {
  const form = useForm();
  const list = asList(form.get(path));
  return (
    <Item path={path} label={label} hint={hint}>
      <div role="group" aria-label={label} className="space-y-1.5">
        {list.map((_, i) => (
          <div key={i} role="group" aria-label={`${label} ${i + 1}`} className="flex items-start gap-1 rounded-lg border border-line p-2">
            <div className="min-w-0 flex-1 space-y-1.5">{children((key) => `${path}.${i}.${key}`, i)}</div>
            <button type="button" className={removeCls} aria-label={t("Remove {item}", { item: `${label} ${i + 1}` })} onClick={() => form.set(path, list.filter((_, j) => j !== i))}>
              <LuX aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button type="button" className={ghostCls} aria-label={`${add}: ${label}`} onClick={() => form.set(path, [...list, blank()])}>
          <LuPlus aria-hidden className="h-3.5 w-3.5" />
          {add}
        </button>
      </div>
    </Item>
  );
}

/** A list of texts. */
function Strings({ path, label, hint, add }: { path: string; label: string; hint?: string; add: string }) {
  const form = useForm();
  const list = asList(form.get(path));
  return (
    <Item path={path} label={label} hint={hint}>
      <div role="group" aria-label={label} className="space-y-1">
        {list.map((v, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              aria-label={`${label} ${i + 1}`}
              className={`${inputSmCls} min-w-0 flex-1 font-mono text-xs`}
              value={typeof v === "string" ? v : JSON.stringify(v)}
              onChange={(e) => form.set(`${path}.${i}`, e.target.value)}
            />
            <button type="button" className={removeCls} aria-label={t("Remove {item}", { item: `${label} ${i + 1}` })} onClick={() => form.set(path, list.filter((_, j) => j !== i))}>
              <LuX aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button type="button" className={ghostCls} aria-label={`${add}: ${label}`} onClick={() => form.set(path, [...list, ""])}>
          <LuPlus aria-hidden className="h-3.5 w-3.5" />
          {add}
        </button>
      </div>
    </Item>
  );
}

/** What a deny rule refuses, written the way the device keeps it: any of r, w and x in that order. */
function Rights({ path }: { path: string }) {
  const form = useForm();
  const v = form.get(path);
  const rights = typeof v === "string" ? v : "rwx";
  return (
    <div role="group" aria-label={t("Refuses")} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      <span>{t("Refuses")}</span>
      {RIGHTS.map((r) => (
        <label key={r.id} className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={rights.includes(r.id)}
            onChange={(e) => {
              const next = RIGHTS.filter((o) => (o.id === r.id ? e.target.checked : rights.includes(o.id))).map((o) => o.id).join("");
              // The device takes a rule with at least one right.
              if (next) form.set(path, next);
            }}
          />
          {t(r.label)}
        </label>
      ))}
    </div>
  );
}

/** Command rules: each one how it matches and the text. */
function RuleList({ path, label, hint }: { path: string; label: string; hint: string }) {
  const form = useForm();
  const list = asList(form.get(path));
  return (
    <Item path={path} label={label} hint={hint}>
      <div role="group" aria-label={label} className="space-y-1">
        {list.map((rule, i) => {
          const kind = RULES.find((k) => isObj(rule) && typeof rule[k.id] === "string")?.id ?? "exact";
          const text = isObj(rule) && typeof rule[kind] === "string" ? (rule[kind] as string) : "";
          return (
            <div key={i} role="group" aria-label={`${label} ${i + 1}`} className="flex flex-wrap items-center gap-1">
              <select aria-label={t("How it matches")} className={`${inputSmCls} !w-auto`} value={kind} onChange={(e) => form.set(`${path}.${i}`, { [e.target.value]: text })}>
                {RULES.map((k) => (
                  <option key={k.id} value={k.id}>
                    {t(k.label)}
                  </option>
                ))}
              </select>
              <input aria-label={t("Text")} className={`${inputSmCls} min-w-0 flex-1 basis-40 font-mono text-xs`} value={text} onChange={(e) => form.set(`${path}.${i}`, { [kind]: e.target.value })} />
              <button type="button" className={removeCls} aria-label={t("Remove {item}", { item: `${label} ${i + 1}` })} onClick={() => form.set(path, list.filter((_, j) => j !== i))}>
                <LuX aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        <button type="button" className={ghostCls} aria-label={`${t("Add a rule")}: ${label}`} onClick={() => form.set(path, [...list, { exact: "" }])}>
          <LuPlus aria-hidden className="h-3.5 w-3.5" />
          {t("Add a rule")}
        </button>
      </div>
    </Item>
  );
}

/** The hours the device serves calls; none means every hour of every day. */
function Hours() {
  const form = useForm();
  const hours = form.get("policy.hours");
  const on = isObj(hours);
  const days = on ? asList(hours.days) : [];
  const time = (key: "from" | "to") => (on && typeof hours[key] === "string" ? (hours[key] as string) : "");
  return (
    <>
      <label className="flex items-start gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          aria-label={t("Serve calls only at certain hours")}
          className="mt-0.5"
          checked={on}
          onChange={(e) => form.set("policy.hours", e.target.checked ? { days: [], from: "08:00", to: "18:00" } : null)}
        />
        <span className="min-w-0">
          {t("Serve calls only at certain hours")}
          <span className="block text-[11px] text-fg-faint">{t("Outside them every call is refused.")}</span>
        </span>
      </label>
      {on && (
        <div className="space-y-2 rounded-lg border border-line p-2">
          <Item path="policy.hours.days" label={t("Days")} hint={t("None picked means every day.")}>
            <div role="group" aria-label={t("Days")} className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
              {DAYS.map((d) => (
                <label key={d.id} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={days.includes(d.id)}
                    onChange={(e) => form.set("policy.hours.days", DAYS.filter((o) => (o.id === d.id ? e.target.checked : days.includes(o.id))).map((o) => o.id))}
                  />
                  {t(d.label)}
                </label>
              ))}
            </div>
          </Item>
          <div className="flex flex-wrap gap-3">
            {(["from", "to"] as const).map((key) => (
              <Item key={key} path={`policy.hours.${key}`} label={key === "from" ? t("From") : t("Until")} hint={key === "to" ? t("An earlier time than From runs past midnight.") : undefined}>
                <input type="time" aria-label={key === "from" ? t("From") : t("Until")} className={`${inputSmCls} !w-32`} value={time(key)} onChange={(e) => form.set(`policy.hours.${key}`, e.target.value)} />
              </Item>
            ))}
          </div>
          <Num path="policy.hours.utc_offset_minutes" label={t("Offset from UTC, in minutes")} nullable hint={t("Empty: the device's own time zone.")} />
        </div>
      )}
    </>
  );
}
