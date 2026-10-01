import { useEffect, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleUser,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from "react-icons/lu";
import { api, type Person, type Role, type ToolRule } from "../api";
import { labelOf, msg, t, tp, tx } from "../i18n";

const inputCls =
  "w-full rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm outline-none transition placeholder:text-fg-faint focus:border-accent/60";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-sm text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40";

const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: "primary", label: msg("Primary"), hint: msg("You. Everything.") },
  {
    id: "colleague",
    label: msg("Colleague"),
    hint: msg("Reads, searches, explains. Anything else needs your say-so."),
  },
  { id: "guest", label: msg("Guest"), hint: msg("Answers what they ask and volunteers nothing.") },
  { id: "unknown", label: msg("Blocked"), hint: msg("Turned away before reaching the agent.") },
];

const roleLabel = (id: string) => {
  const role = ROLES.find((r) => r.id === id);
  return role ? t(role.label) : id;
};

/** Who a rule for a whole role reaches, said of them all. */
const EVERYONE: Record<string, string> = {
  primary: msg("the primary user"),
  colleague: msg("all colleagues"),
  guest: msg("all guests"),
  unknown: msg("everyone blocked"),
  heartbeat: msg("every agent's heartbeat"),
};

const ROLE_STYLE: Record<string, string> = {
  primary: "text-accent",
  colleague: "text-fg-muted",
  guest: "text-fg-subtle",
  unknown: "text-warn",
};

/**
 * Everyone who has spoken to the agent.
 *
 * A list of names, and a page each. The roster is read far more often than it
 * is changed — usually to see whether somebody got through — so the settings
 * live one click in rather than in every row.
 *
 * Strangers appear here having already been refused: the list is how you let
 * somebody in, not a log of who got through.
 */
export function PeoplePanel({ onError }: { onError: (e: string) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [rules, setRules] = useState<ToolRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const [p, r] = await Promise.all([api.people(), api.toolRules()]);
      setPeople(p.people);
      setRules(r.rules);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-subtle">
        <LuRefreshCw className="h-3.5 w-3.5 animate-spin" /> {t("Loading…")}
      </p>
    );
  }

  const open = people.find((p) => p.key === openKey);
  if (open) {
    return (
      <PersonDetail
        person={open}
        rules={rules.filter((r) => r.person_key === open.key)}
        onBack={() => setOpenKey(null)}
        onChanged={load}
        onError={onError}
      />
    );
  }

  const waiting = people.filter((p) => p.role === "unknown");
  const roleWide = rules.filter((r) => !r.person_key);

  return (
    <>
      {waiting.length > 0 && (
        <section className="mb-4 flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 p-3">
          <LuTriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <p className="text-xs text-fg-muted">
            {tp(waiting.length, "Someone has messaged the agent and been turned away. Open them to let them through.", "{n} people have messaged the agent and been turned away. Open them to let them through.")}
          </p>
        </section>
      )}

      <p className="mb-3 text-xs text-fg-faint">
        {t("The agent only talks to people listed here. Identities come from the platform's own id, so renaming themselves changes nothing.")}
      </p>

      {people.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-fg-faint">
          {t("Nobody yet. People appear here the first time they message a channel.")}
        </p>
      ) : (
        <ul className="space-y-1">
          {people.map((p) => (
            <li key={p.key}>
              <button
                onClick={() => setOpenKey(p.key)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-raised/40 px-3 py-2 text-left transition hover:bg-fg/5"
              >
                <LuCircleUser className="h-4 w-4 shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{p.name}</span>
                <span className={`shrink-0 text-xs ${ROLE_STYLE[p.role] ?? "text-fg-subtle"}`}>
                  {roleLabel(p.role)}
                </span>
                <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {roleWide.length > 0 && (
        <section className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("Allowed for a whole role")}
          </h3>
          <ul className="mt-2 space-y-1">
            {roleWide.map((r) => (
              <RuleRow
                key={r.id}
                rule={r}
                scope={labelOf(EVERYONE, r.role, (role) => t("everyone with the role {role}", { role }))}
                onDelete={async () => {
                  try {
                    setRules((await api.deleteToolRule(r.id)).rules);
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function RuleRow({
  rule,
  scope,
  onDelete,
}: {
  rule: ToolRule;
  scope?: string;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 py-1 pl-2.5 pr-1">
      {scope && (
        <span className="shrink-0 rounded bg-fg/5 px-1.5 py-0.5 text-[11px] text-fg-muted">
          {scope}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
        {rule.tool}: {rule.pattern}
      </span>
      <button
        onClick={onDelete}
        title={t("Revoke")}
        className="shrink-0 rounded-lg p-1 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
      >
        <LuTrash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function PersonDetail({
  person,
  rules,
  onBack,
  onChanged,
  onError,
}: {
  person: Person;
  rules: ToolRule[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState(person.name);
  const [role, setRole] = useState<Role>(person.role);
  const [notes, setNotes] = useState(person.notes);
  const [tool, setTool] = useState("bash");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(person.name);
    setRole(person.role);
    setNotes(person.notes);
  }, [person.key]);

  const dirty = name !== person.name || role !== person.role || notes !== person.notes;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-xs text-fg-subtle transition hover:text-fg-muted"
        >
          <LuChevronLeft className="h-3.5 w-3.5" /> {t("People")}
        </button>
        <span className="ml-auto truncate font-mono text-[11px] text-fg-faint">{person.key}</span>
        <button
          disabled={busy}
          title={t("Forget — the next message from them arrives as a stranger again")}
          onClick={() =>
            act(async () => {
              await api.forgetPerson(person.key);
              onBack();
            })
          }
          className="rounded-lg p-1 text-fg-faint transition hover:bg-danger/10 hover:text-danger"
        >
          <LuTrash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-fg-subtle">{t("Name")}</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <div>
          <span className="mb-1 block text-xs text-fg-subtle">{t("Role")}</span>
          <div className="grid grid-cols-4 gap-1">
            {ROLES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRole(r.id)}
                className={`rounded-lg px-2 py-1.5 text-xs transition ${
                  role === r.id
                    ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"
                    : "bg-fg/5 text-fg-muted hover:bg-fg/10"
                }`}
              >
                {t(r.label)}
              </button>
            ))}
          </div>
          {/* One line for the choice in front of you, rather than four
              descriptions competing for the same attention. */}
          <p className="mt-1 text-[11px] text-fg-faint">
            {t(ROLES.find((r) => r.id === role)?.hint ?? "")}
          </p>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-fg-subtle">{t("What the agent should know")}</span>
          <textarea
            className={inputCls}
            rows={2}
            value={notes}
            placeholder={t("Their role, what they work on — repeated to the agent every time they write.")}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {dirty && (
          <button
            className={primaryCls}
            disabled={busy}
            onClick={() =>
              act(async () => {
                await api.updatePerson(person.key, { name, role, notes });
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              })
            }
          >
            {busy ? (
              <LuRefreshCw className="h-4 w-4 animate-spin" />
            ) : saved ? (
              <LuCheck className="h-4 w-4" />
            ) : null}
            {t("Save")}
          </button>
        )}
      </div>

      <section className="mt-6">
        <div className="mb-1.5 flex items-baseline gap-2">
          <h3 className="text-sm font-medium text-fg">{t("Allowed anyway")}</h3>
          <span className="text-xs text-fg-faint">{rules.length}</span>
        </div>
        <p className="mb-2 text-[11px] text-fg-faint">
          {tx("What {name} may do despite their role — written by {allow}, revoked by deleting. {star} covers the parts that vary; a shell rule matches one command, never a pipeline.", { name: person.name, allow: <em>{t("Always allow")}</em>, star: <span className="font-mono">*</span> })}
        </p>

        {rules.length > 0 && (
          <ul className="mb-2 space-y-1">
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} onDelete={() => act(() => api.deleteToolRule(r.id))} />
            ))}
          </ul>
        )}

        <div className="flex gap-1">
          <input
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            placeholder="bash"
            className="w-20 rounded-lg border border-line bg-raised/60 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60"
          />
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="himalaya envelope list*"
            className="min-w-0 flex-1 rounded-lg border border-line bg-raised/60 px-2 py-1.5 font-mono text-[11px] outline-none placeholder:text-fg-faint focus:border-accent/60"
          />
          <button
            disabled={busy || !pattern.trim()}
            onClick={() =>
              act(async () => {
                await api.addToolRule({ role: person.role, tool, pattern, personKey: person.key });
                setPattern("");
              })
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent/12 px-2.5 py-1.5 text-[11px] text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
          >
            <LuPlus className="h-3 w-3" /> {t("Allow")}
          </button>
        </div>
      </section>
    </>
  );
}
