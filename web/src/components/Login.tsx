import { useState } from "react";
import { api, ApiError } from "../api";
import { t } from "../i18n";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      // The server's own word where it refused (a wrong password, too many tries). Anything else is
      // not the server saying no: a proxy's "HTTP 502" while the portal restarts reads like a broken login.
      setError(err instanceof ApiError && (err.status === 401 || err.status === 429) ? err.message : t("Cannot reach the portal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-[19rem]">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/icon-512.png" alt="" className="h-16 w-16 object-contain p-3" draggable={false} />
          <h1 className="mt-3 text-base font-semibold tracking-tight text-fg">Pithagoras</h1>
          <p className="mt-1 text-xs text-fg-subtle">
            {t("Give it a task, close the browser, come back later.")}
          </p>
        </div>

        <input
          autoFocus
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("Password")}
          aria-label={t("Password")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-fg outline-none transition placeholder:text-fg-faint focus:border-accent/50 focus:ring-4 focus:ring-accent/10"
        />
        {error && <p id="login-error" role="alert" className="mt-2 text-xs text-danger">{error}</p>}

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-3 w-full rounded-xl bg-accent px-3 py-2.5 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? t("Checking…") : t("Sign in")}
        </button>
      </form>
    </div>
  );
}
