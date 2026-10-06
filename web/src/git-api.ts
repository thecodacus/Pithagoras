import { json } from "./api";

/**
 * The Git panel's side of the portal: the repository a chat's folder is in,
 * and GitHub through gh. The shapes are the server's (server/src/git.ts).
 */

export interface Counts {
  added: number;
  removed: number;
  binary: boolean;
}

export interface ChangedFile {
  path: string;
  from?: string;
  /** The index against HEAD, and the working tree against the index: "." for unchanged, "?" for new. */
  x: string;
  y: string;
  kind: "changed" | "renamed" | "conflict" | "untracked";
  staged?: Counts;
  unstaged?: Counts;
}

export interface Remote {
  name: string;
  address: string;
  web?: string;
}

export interface GhState {
  installed: boolean;
  authed: boolean;
  repo: string | null;
  url: string | null;
  defaultBranch: string | null;
  /** The default branch on the remote that is that repository, e.g. "upstream/main" in a fork's clone. */
  baseRef?: string | null;
  note?: string;
}

export type GitState =
  | { repo: false; folder: string }
  | {
      repo: true;
      root: string;
      /** The chat's folder inside the repository, "" at its top. */
      prefix: string;
      branch: string | null;
      head: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      stashes: number;
      operation: "merge" | "rebase" | "am" | "cherry-pick" | "revert" | null;
      files: ChangedFile[];
      truncated: boolean;
      remotes: Remote[];
    };

export interface Commit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  refs: string[];
  subject: string;
}

export interface FileChange {
  path: string;
  from?: string;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface CommitDetail extends Commit {
  message: string;
  committer: string;
  files: FileChange[];
}

export interface Branch {
  name: string;
  remote: boolean;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  current: boolean;
  date: number;
  subject: string;
}

export interface Stash {
  ref: string;
  sha: string;
  date: number;
  message: string;
}

export interface Comparison {
  base: string;
  head: string;
  mergeBase: string;
  commits: Commit[];
  files: FileChange[];
}

/** A pull request in a list, as gh gives it. */
export interface PullSummary {
  number: number;
  title: string;
  author?: { login: string };
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: string;
  updatedAt: string;
  url: string;
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
}

export interface Check {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface PullDetail extends PullSummary {
  body: string;
  /** Whether its branch is in another repository, a fork: then `headRefName` is a name there, not here. */
  isCrossRepository?: boolean;
  headRepositoryOwner?: { login: string };
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: Check[];
  changedFiles?: number;
  files?: { path: string; additions: number; deletions: number }[];
  commits?: { oid: string; messageHeadline: string; authors?: { login?: string; name?: string }[] }[];
  comments?: { author?: { login: string }; body: string; createdAt: string }[];
  reviews?: { author?: { login: string }; body: string; state: string; submittedAt: string }[];
  createdAt?: string;
}

export interface Diff {
  diff: string;
  truncated: boolean;
}

export type DiffOf =
  | { of: "unstaged" | "staged"; path: string; from?: string }
  | { of: "untracked"; path: string }
  | { of: "commit"; sha: string; path?: string; from?: string }
  | { of: "range"; base: string; path?: string; from?: string }
  | { of: "stash"; stash: string };

const base = (id: string) => `/api/sessions/${encodeURIComponent(id)}/git`;
const post = <T = { ok: true }>(url: string, body: unknown = {}) => json<T>(url, { method: "POST", body: JSON.stringify(body) });
const query = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export const gitApi = {
  state: (id: string) => json<GitState>(base(id)),
  init: (id: string) => post(`${base(id)}/init`),
  /** Asked apart from the state: it asks GitHub, and the state is what is on this disk. */
  gh: (id: string, fresh = false) => json<GhState>(`${base(id)}/gh${fresh ? "?fresh=1" : ""}`),
  diff: (id: string, what: DiffOf) => json<Diff>(`${base(id)}/diff?${query(what as Record<string, string>)}`),
  stage: (id: string, paths: string[] | "all") => post(`${base(id)}/stage`, paths === "all" ? { all: true } : { paths }),
  unstage: (id: string, paths: string[] | "all") => post(`${base(id)}/unstage`, paths === "all" ? { all: true } : { paths }),
  discard: (id: string, paths: string[]) => post(`${base(id)}/discard`, { paths }),
  commit: (id: string, message: string, amend = false) => post<{ sha: string }>(`${base(id)}/commit`, { message, amend }),
  abort: (id: string) => post(`${base(id)}/abort`),
  continue: (id: string) => post(`${base(id)}/continue`),
  log: (id: string, opts: { ref?: string; skip?: number; limit?: number; path?: string } = {}) =>
    json<{ commits: Commit[] }>(`${base(id)}/log?${query(opts)}`),
  commitDetail: (id: string, sha: string) => json<CommitDetail>(`${base(id)}/commits/${encodeURIComponent(sha)}`),
  branches: (id: string) => json<{ branches: Branch[] }>(`${base(id)}/branches`),
  switch: (id: string, name: string, remote = false) => post(`${base(id)}/switch`, { name, remote }),
  createBranch: (id: string, name: string, from?: string) => post(`${base(id)}/branches`, { name, from }),
  deleteBranch: (id: string, name: string, force = false) => post(`${base(id)}/branches/delete`, { name, force }),
  fetch: (id: string) => post<{ said: string }>(`${base(id)}/fetch`),
  pull: (id: string) => post<{ said: string }>(`${base(id)}/pull`),
  push: (id: string) => post<{ said: string }>(`${base(id)}/push`),
  stashes: (id: string) => json<{ stashes: Stash[] }>(`${base(id)}/stashes`),
  stash: (id: string, message?: string) => post(`${base(id)}/stashes`, { message }),
  /** `sha` is the stash meant: nothing is done when `ref` has come to be another. */
  stashDo: (id: string, action: "apply" | "pop" | "drop", ref: string, sha: string) => post(`${base(id)}/stashes/${action}`, { ref, sha }),
  compare: (id: string, baseRef?: string) => json<{ comparison: Comparison | null }>(`${base(id)}/compare?${query({ base: baseRef })}`),
  pulls: (id: string, state = "open") => json<{ pulls: PullSummary[] }>(`${base(id)}/pulls?state=${state}`),
  currentPull: (id: string) => json<{ pull: PullDetail | null }>(`${base(id)}/pulls/current`),
  pullDetail: (id: string, n: number) => json<{ pull: PullDetail }>(`${base(id)}/pulls/${n}`),
  pullDiff: (id: string, n: number) => json<Diff>(`${base(id)}/pulls/${n}/diff`),
  createPull: (id: string, opts: { title: string; body: string; base?: string; draft?: boolean }) => post<{ url: string }>(`${base(id)}/pulls`, opts),
  checkoutPull: (id: string, n: number) => post(`${base(id)}/pulls/${n}/checkout`),
  mergePull: (id: string, n: number, method: "merge" | "squash" | "rebase", deleteBranch: boolean) =>
    post<{ said: string }>(`${base(id)}/pulls/${n}/merge`, { method, deleteBranch }),
  commentPull: (id: string, n: number, body: string) => post(`${base(id)}/pulls/${n}/comment`, { body }),
  reviewPull: (id: string, n: number, action: "approve" | "request-changes" | "comment", body: string) =>
    post(`${base(id)}/pulls/${n}/review`, { action, body }),
};
