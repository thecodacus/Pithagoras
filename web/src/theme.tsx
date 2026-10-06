import { useEffect, useState } from "react";
import { local } from "./safe-storage";

/**
 * Light, dark, or whatever the machine is set to.
 *
 * "system" is the default and a real option rather than a one-off starting
 * guess: someone whose desktop flips at sunset expects this to follow, and a
 * portal that decided once at first load would not.
 */
export type Theme = "light" | "dark" | "system";

const KEY = "pithagoras.theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

export const resolve = (theme: Theme): "light" | "dark" =>
  theme === "system" ? (media().matches ? "light" : "dark") : theme;

function apply(theme: Theme) {
  const root = document.documentElement;
  // Transitions are enabled only for the moment of the change, so the whole app
  // does not fade every time something re-renders.
  root.classList.add("theme-switching");
  root.dataset.theme = resolve(theme);
  // The installed app's title bar follows the page, not only the machine.
  const canvas = getComputedStyle(root).getPropertyValue("--canvas").trim().split(/\s+/).join(", ");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", `rgb(${canvas})`);
  window.setTimeout(() => root.classList.remove("theme-switching"), 200);
}

function stored(): Theme {
  const value = local.get(KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    apply(theme);
    // Not kept in private mode; the theme still applies for this session.
    local.set(KEY, theme);
    if (theme !== "system") return;
    const mq = media();
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme, resolved: resolve(theme) };
}

/**
 * The theme in effect, for the rare thing that needs the value rather than the
 * CSS variables — mermaid draws an SVG with baked-in colours, so it has to be
 * told. Read off the attribute `apply()` writes, so there is still one source
 * of truth and no second copy of the preference to keep in step.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setResolved(root.dataset.theme === "light" ? "light" : "dark");
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    read();
    return () => observer.disconnect();
  }, []);
  return resolved;
}
