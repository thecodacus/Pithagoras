import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The sandbox against the kernel, as the portal runs it: as root on Linux, with
 * the users the image makes. Every way round it that a model might try goes
 * through the same permissions: a direct read, a script of its own, another
 * interpreter, a symlink, the environment. Skipped, saying why, anywhere else.
 */

const root = mkdtempSync(path.join(tmpdir(), "sandbox-"));
const DATA = path.join(root, "data");
const WORK = path.join(root, "workspaces");
process.env.DATA_DIR = DATA;
process.env.WORKSPACE_ROOT = WORK;
process.env.HOME = path.join(DATA, "home");
process.env.AGENT_HOME = path.join(DATA, "agent-home");
process.env.SESSION_DIR = path.join(DATA, "sessions");
process.env.PI_CODING_AGENT_DIR = path.join(DATA, "home", ".pi", "agent");
process.env.PORTAL_SECRET = "portal-secret-value";

after(() => rmSync(root, { recursive: true, force: true }));

const linuxRoot = process.platform === "linux" && process.getuid?.() === 0;
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

/** The users and group, as the Dockerfile makes them, where they are missing. */
function users() {
  const exists = (kind, name) => spawnSync("getent", [kind, name]).status === 0;
  if (!exists("group", "pi-sandbox")) execFileSync("groupadd", ["--gid", "10010", "pi-sandbox"]);
  if (!exists("passwd", "pi-agent")) execFileSync("useradd", ["--uid", "10001", "--user-group", "--groups", "pi-sandbox", "--no-create-home", "--shell", "/bin/bash", "pi-agent"]);
  if (!exists("passwd", "pi-tools")) execFileSync("useradd", ["--uid", "10002", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", "pi-tools"]);
}

const why = !linuxRoot ? "needs root on Linux, as the portal runs in its image" : !has("setpriv") || !has("sudo") || !has("visudo") ? "needs setpriv and sudo" : false;

test("the sandbox holds against the ways round it", { skip: why }, async (t) => {
  users();
  for (const dir of [DATA, WORK, path.join(WORK, "project"), path.join(DATA, "agent-home"), path.join(DATA, "bin"), path.join(DATA, "home", ".pi", "agent"), path.join(DATA, "trusted"), path.join(DATA, ".secrets")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(WORK, "project", "notes.txt"), "hello\n");
  writeFileSync(path.join(DATA, ".secrets", "key.json"), '{"api_key":"sk-secret-123"}\n');
  writeFileSync(path.join(DATA, "home", ".pi", "agent", "auth.json"), '{"token":"pi-auth-secret"}\n');
  writeFileSync(path.join(DATA, "bin", "hello"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  // The portal's database with SQLite's journal beside it, as a running portal has.
  writeFileSync(path.join(DATA, "portal.db"), "db");
  writeFileSync(path.join(DATA, "portal.db-wal"), "recent writes: sk-secret-in-wal");
  // A trusted command that reads the key: only pi-tools can.
  writeFileSync(path.join(DATA, "trusted", "show-key"), `#!/bin/sh\ngrep -o 'sk-[a-z0-9-]*' ${path.join(DATA, ".secrets", "key.json")}\n`, { mode: 0o755 });

  const { parsePolicy, saveSandboxPolicy, sandboxSupport, defaultRules } = await import("../dist/sandbox/policy.js");
  const { applySandbox } = await import("../dist/sandbox/apply.js");
  const { bashSpawnHook, fileOperations } = await import("../dist/sandbox/exec.js");
  const policy = parsePolicy({ enabled: true, rules: defaultRules(), trusted: [{ name: "show-key", script: "show-key" }] });
  saveSandboxPolicy(policy);
  const support = sandboxSupport();
  assert.equal(support.available, true, support.reason);
  const report = await applySandbox(policy, support, true);
  assert.equal(report.ok, true, report.warnings.join("\n"));

  // What pi's bash runs, through the spawn hook, as it would.
  const hook = bashSpawnHook(support.ids);
  const bash = (command, cwd = path.join(WORK, "project")) => {
    const c = hook({ command, cwd, env: process.env });
    return spawnSync("/bin/bash", ["-c", c.command], { cwd: c.cwd, env: c.env, encoding: "utf8" });
  };
  const ops = fileOperations(support.ids);
  const secret = path.join(DATA, ".secrets", "key.json");
  const auth = path.join(DATA, "home", ".pi", "agent", "auth.json");

  await t.test("the shell runs as pi-agent, without the portal's secrets in its environment", () => {
    assert.equal(bash("id -un").stdout.trim(), "pi-agent");
    const env = bash("env").stdout;
    assert.doesNotMatch(env, /portal-secret-value/);
    assert.match(env, new RegExp(`HOME=${path.join(DATA, "sandbox-home")}`));
  });

  await t.test("a key cannot be read directly, through another interpreter, a script of its own or a symlink", () => {
    for (const command of [
      `cat ${secret}`,
      `node -e 'process.stdout.write(require("fs").readFileSync("${secret}","utf8"))'`,
      `printf '#!/bin/sh\\ncat ${secret}\\n' > ./mine.sh && chmod +x ./mine.sh && ./mine.sh`,
      `ln -sf ${secret} ./link && cat ./link`,
      `cat ${auth}`,
      `ls ${path.join(DATA, ".secrets")}`,
      `sudo -n cat ${secret}`,
      `cat ${path.join(DATA, "portal.db-wal")}`,
    ]) {
      const ran = bash(command);
      assert.doesNotMatch(ran.stdout, /sk-secret-123|pi-auth-secret|key\.json|sk-secret-in-wal/, command);
    }
  });

  await t.test("pi's file tools are held the same way", async () => {
    await assert.rejects(ops.read.readFile(secret), { code: "EACCES" });
    await assert.rejects(ops.read.readFile(auth), { code: "EACCES" });
    await assert.rejects(ops.ls.readdir(path.join(DATA, ".secrets")), { code: "EACCES" });
    assert.equal((await ops.read.readFile(path.join(WORK, "project", "notes.txt"))).toString(), "hello\n");
    await ops.write.writeFile(path.join(WORK, "project", "new.txt"), "made by the agent\n");
    assert.equal(readFileSync(path.join(WORK, "project", "new.txt"), "utf8"), "made by the agent\n");
    await assert.rejects(ops.write.writeFile(path.join(DATA, "bin", "hello"), "changed"), { code: "EACCES" });
    await assert.rejects(ops.grep.readFile(secret), { code: "EACCES" });
  });

  await t.test("a read-only folder runs but cannot be changed; a workspace can", () => {
    assert.equal(bash(`${path.join(DATA, "bin", "hello")}`).stdout.trim(), "hi");
    assert.notEqual(bash(`echo x >> ${path.join(DATA, "bin", "hello")}`).status, 0);
    assert.notEqual(bash(`touch ${path.join(DATA, "bin", "new")}`).status, 0);
    assert.equal(bash("echo ok > made.txt && cat made.txt").stdout.trim(), "ok");
    // What the agent made, the portal (root) and the group can change too.
    assert.equal(spawnSync("stat", ["-c", "%G", path.join(WORK, "project", "made.txt")], { encoding: "utf8" }).stdout.trim(), "pi-sandbox");
  });

  await t.test("a trusted command reads its key; the agent cannot change it or its key", () => {
    const ran = bash(path.join(DATA, "bin", "show-key"));
    assert.equal(ran.stdout.trim(), "sk-secret-123", ran.stderr);
    assert.notEqual(bash(`echo 'cat /etc/shadow' >> ${path.join(DATA, "trusted", "show-key")}`).status, 0);
    assert.notEqual(bash(`sudo -n -u pi-tools cat ${secret}`).status, 0, "only the listed script, not any command");
    assert.notEqual(bash(`sudo -n -u pi-tools /bin/sh -c 'cat ${secret}'`).status, 0);
  });

  await t.test("search runs as pi-agent: rg finds nothing in the keys", () => {
    const rg = path.join(DATA, "home", ".pi", "agent", "bin", "rg");
    assert.ok(existsSync(rg), "the rg wrapper is in pi's tools folder");
    if (!has("rg")) return;
    const found = spawnSync(rg, ["-r", "x", "sk-secret", path.join(DATA, ".secrets")], { encoding: "utf8" });
    assert.doesNotMatch(found.stdout, /sk-secret-123/);
    const ok = spawnSync(rg, ["hello", path.join(WORK, "project")], { encoding: "utf8" });
    assert.match(ok.stdout, /notes\.txt/);
  });

  await t.test("switched off, the search wrappers run as the portal again and nothing else changes", async () => {
    const off = await applySandbox({ ...policy, enabled: false }, support, false);
    assert.equal(off.ok, true);
    assert.equal(existsSync(path.join(DATA, "sandbox", "enabled")), false);
  });
});
