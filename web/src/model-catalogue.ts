import type { PiModel } from "./api";

/**
 * The model catalogue, kept between sessions and reloads.
 *
 * Fetching it starts pi and enumerates a few hundred models, which is slow
 * enough that opening the picker sat on "Loading models…" every time. The
 * providers are portal-wide, so one cache serves every session.
 *
 * It goes when a provider is changed in Settings, and it expires: a provider
 * can change without this browser seeing it — from another device, or by the
 * agent editing pi's files — and the menu would otherwise show the old list
 * until somebody asked for a new one.
 */
const CATALOGUE_KEY = "modelCatalogue.v2";
/** The cache before it carried the time it was fetched; it is only ever removed. */
const OLD_KEY = "modelCatalogue.v1";
export const CATALOGUE_TTL_MS = 60 * 60 * 1000;

interface Cached { at: number; models: PiModel[] }

function read(): Cached | null {
  try {
    localStorage.removeItem(OLD_KEY);
    const raw = localStorage.getItem(CATALOGUE_KEY);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

/** Whether the cached list was fetched within the expiry. */
export const catalogueFresh = (now = Date.now()): boolean => {
  const cached = read();
  return !!cached && now - cached.at < CATALOGUE_TTL_MS;
};

/** The cached list while it is fresh; nothing once it has expired or been forgotten. */
export const cachedModels = (now = Date.now()): PiModel[] => (catalogueFresh(now) ? read()!.models : []);

export const cacheModels = (models: PiModel[], now = Date.now()) => {
  try {
    if (models.length) localStorage.setItem(CATALOGUE_KEY, JSON.stringify({ at: now, models } satisfies Cached));
  } catch {
    // A full quota is not worth failing a dropdown over.
  }
};

/** A provider was changed: the next model menu opened, in any tab, fetches the list again. */
export const forgetModels = () => {
  try {
    localStorage.removeItem(CATALOGUE_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
};
