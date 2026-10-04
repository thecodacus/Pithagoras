import { spawn } from "node:child_process";
import { AGENT_USER, SANDBOX_HOME, type SandboxSupport } from "./policy.js";

/**
 * Doing things as the sandbox user: the agent's shell commands, and what pi's
 * file tools do to files, so that the kernel decides each of them by the
 * permissions the policy put on the files.
 */

type Ids = NonNullable<SandboxSupport["ids"]>;

/**
 * The argv that runs the rest as `pi-agent`: its uid, its own group and the
 * sandbox group, and no capabilities carried over. New privileges are not
 * blocked: sudo has to be able to run a trusted command as `pi-tools`, which
 * the sudoers rules restrict to exactly those commands.
 */
export function asAgent(ids: Ids): string[] {
  return ["setpriv", `--reuid=${ids.agent}`, `--regid=${ids.agent}`, `--groups=${ids.group}`, "--inh-caps=-all", "--"];
}

/** Variables passed on: the shell's and the terminal's, and pi's own session metadata. */
const KEEP = new Set(["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "COLUMNS", "LINES", "NO_COLOR", "FORCE_COLOR", "PITHAGORAS_AGENT"]);

/**
 * The sandbox's environment: a short list, nothing else. The portal's own
 * holds its password, its secret and provider keys, and a command could print
 * them with `env`. pi's PI_* session variables stay (they say which session
 * this is), except the ones that point into the portal's HOME.
 */
export function sandboxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (KEEP.has(key) || (key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR" && !/KEY|TOKEN|SECRET|PASSWORD/.test(key))) out[key] = value;
  }
  out.HOME = SANDBOX_HOME;
  out.USER = AGENT_USER;
  out.LOGNAME = AGENT_USER;
  out.SHELL = "/bin/bash";
  out.TMPDIR = "/tmp";
  out.PATH ??= "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return out;
}

/** A word for sh, quoted so nothing in it is read as shell syntax. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * pi's bash spawn hook: the command, as typed, run by bash as `pi-agent`, with
 * a umask that leaves what it makes writable for the group, so the portal and
 * the agent can both change it later.
 */
export function bashSpawnHook(ids: Ids) {
  return (context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
    command: `exec ${asAgent(ids).join(" ")} /bin/bash -c ${shQuote(`umask 002\n${context.command}`)}`,
    cwd: context.cwd,
    env: sandboxEnv(context.env),
  });
}

interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs argv as `pi-agent`, with `input` on stdin; never throws for a non-zero exit. */
export function runAsAgent(ids: Ids, argv: string[], input?: Buffer | string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = [...asAgent(ids), ...argv];
    const child = spawn(cmd, args, { env: sandboxEnv(process.env), cwd: "/", stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err.trim() }));
    child.stdin.end(input ?? "");
  });
}

/** An error as fs would throw it, from what the command said: "Permission denied" reads as EACCES. */
function fsError(op: string, target: string, ran: Ran): Error {
  const denied = /permission denied|operation not permitted/i.test(ran.stderr);
  const missing = /no such file|not a directory/i.test(ran.stderr);
  const code = denied ? "EACCES" : missing ? "ENOENT" : "EIO";
  const why = denied ? "the sandbox does not let the agent do that here" : ran.stderr || `exit ${ran.code}`;
  const e = new Error(`${op} ${target}: ${why}`) as NodeJS.ErrnoException;
  e.code = code;
  e.path = target;
  return e;
}

/**
 * What pi's file tools do to files, done as `pi-agent`: read, write, edit,
 * ls, and grep's own reading of context lines. grep's search and find's are
 * run by rg and fd, which the portal points at the sandbox in the same way
 * (see apply.ts, toolWrappers).
 */
export function fileOperations(ids: Ids) {
  const run = (argv: string[], input?: Buffer | string) => runAsAgent(ids, argv, input);
  const test = async (flag: string, p: string) => (await run(["test", flag, p])).code === 0;
  const readFile = async (p: string) => {
    const ran = await run(["cat", "--", p]);
    if (ran.code !== 0) throw fsError("read", p, ran);
    return ran.stdout;
  };
  const writeFile = async (p: string, content: string) => {
    const ran = await run(["sh", "-c", 'umask 002; cat > "$1"', "sh", p], content);
    if (ran.code !== 0) throw fsError("write", p, ran);
  };
  const access = async (p: string, write = false) => {
    if (!(await test("-e", p))) throw fsError("access", p, { code: 1, stdout: Buffer.alloc(0), stderr: "No such file or directory" });
    if (!(await test("-r", p)) || (write && !(await test("-w", p)))) throw fsError("access", p, { code: 1, stdout: Buffer.alloc(0), stderr: "Permission denied" });
  };
  return {
    read: { readFile, access: (p: string) => access(p) },
    write: {
      writeFile,
      mkdir: async (dir: string) => {
        const ran = await run(["sh", "-c", 'umask 002; mkdir -p -- "$1"', "sh", dir]);
        if (ran.code !== 0) throw fsError("mkdir", dir, ran);
      },
    },
    edit: { readFile, writeFile, access: (p: string) => access(p, true) },
    ls: {
      exists: (p: string) => test("-e", p),
      stat: async (p: string) => {
        const dir = await test("-d", p);
        if (!dir && !(await test("-e", p))) throw fsError("stat", p, { code: 1, stdout: Buffer.alloc(0), stderr: "No such file or directory" });
        return { isDirectory: () => dir };
      },
      readdir: async (p: string) => {
        const ran = await run(["find", p, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"]);
        if (ran.code !== 0) throw fsError("list", p, ran);
        return ran.stdout.toString("utf8").split("\0").filter(Boolean);
      },
    },
    grep: {
      isDirectory: async (p: string) => {
        if (await test("-d", p)) return true;
        if (await test("-e", p)) return false;
        throw fsError("grep", p, { code: 1, stdout: Buffer.alloc(0), stderr: "No such file or directory" });
      },
      readFile: async (p: string) => (await readFile(p)).toString("utf8"),
    },
  };
}
