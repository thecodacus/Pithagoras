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
  execFileSync("git", ["init", "-q", path.join(WORK, "existing")]);
  writeFileSync(path.join(DATA, ".secrets", "key.json"), '{"api_key":"sk-secret-123"}\n');
  writeFileSync(path.join(DATA, "home", ".pi", "agent", "auth.json"), '{"token":"pi-auth-secret"}\n');
  writeFileSync(path.join(DATA, "bin", "hello"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  // A trusted command that reads the key: only pi-tools can.
  writeFileSync(path.join(DATA, "trusted", "show-key"), `#!/bin/sh\ngrep -o 'sk-[a-z0-9-]*' ${path.join(DATA, ".secrets", "key.json")}\n`, { mode: 0o755 });

  const { parsePolicy, saveSandboxPolicy, sandboxSupport, defaultRules } = await import("../dist/sandbox/policy.js");
  const { applySandbox } = await import("../dist/sandbox/apply.js");
  const { bashSpawnHook, fileOperations } = await import("../dist/sandbox/exec.js");
  // /sys is read-only in a container, as /certs is on a portal that mounts it so: put on first, as the widest.
  const policy = parsePolicy({ enabled: true, rules: [{ path: "/sys", access: "none" }, ...defaultRules()], trusted: [{ name: "show-key", script: "show-key" }] });
  saveSandboxPolicy(policy);
  const support = sandboxSupport();
  assert.equal(support.available, true, support.reason);
  const report = await applySandbox(policy, support, true);
  assert.equal(report.ok, true, report.warnings.join("\n"));
  // A rule on a read-only filesystem is noted and the others still go on.
  if (spawnSync("sh", ["-c", "touch /sys/x 2>&1 | grep -q 'Read-only'"]).status === 0) assert.ok(report.done.some((d) => /^\/sys: on a read-only filesystem/.test(d)), report.done.join("\n"));

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
    ]) {
      const ran = bash(command);
      assert.doesNotMatch(ran.stdout, /sk-secret-123|pi-auth-secret|key\.json/, command);
    }
  });

  await t.test("the portal's database and the journal SQLite keeps beside it are closed", () => {
    // Saving the policy opened the real database, in WAL mode, as a running portal has it.
    for (const file of ["portal.db", "portal.db-wal"]) {
      if (!existsSync(path.join(DATA, file))) continue;
      const ran = bash(`cat ${path.join(DATA, file)} | wc -c`);
      assert.match(ran.stderr, /Permission denied/, file);
    }
  });

  await t.test("pi's file tools are held the same way", async () => {
    await assert.rejects(ops.read.readFile(secret), { code: "EACCES" });
    // Refused as not allowed, not as missing: "not found" would send the agent looking elsewhere.
    await assert.rejects(ops.read.access(secret), { code: "EACCES" });
    assert.equal(await ops.ls.exists(secret), true);
    await assert.rejects(ops.read.access(path.join(WORK, "project", "nothing-here")), { code: "ENOENT" });
    await assert.rejects(ops.read.readFile(auth), { code: "EACCES" });
    await assert.rejects(ops.ls.readdir(path.join(DATA, ".secrets")), { code: "EACCES" });
    assert.equal((await ops.read.readFile(path.join(WORK, "project", "notes.txt"))).toString(), "hello\n");
    await ops.write.writeFile(path.join(WORK, "project", "new.txt"), "made by the agent\n");
    assert.equal(readFileSync(path.join(WORK, "project", "new.txt"), "utf8"), "made by the agent\n");
    await assert.rejects(ops.write.writeFile(path.join(DATA, "bin", "hello"), "changed"), { code: "EACCES" });
    await assert.rejects(ops.grep.readFile(secret), { code: "EACCES" });
  });

  await t.test("git works in a project that belongs to root, without the agent trusting it first", () => {
    // Made before the policy went on, as the projects on a portal are.
    const ran = bash("git status --short && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m first && git log --format=%s -1", path.join(WORK, "existing"));
    assert.doesNotMatch(ran.stderr, /dubious ownership/);
    assert.equal(ran.stdout.trim().split("\n").pop(), "first", ran.stderr);
  });

  await t.test("a project added after the policy went on is the agent's to change once a chat starts in it", async () => {
    const later = path.join(WORK, "later");
    execFileSync("git", ["init", "-q", later]);
    const commit = () => bash("git -c user.name=t -c user.email=t@t commit -q --allow-empty -m later && git log --format=%s -1", later);
    assert.notEqual(commit().status, 0, "root's repository, with root's umask, before the chat");
    const { prepareFolder } = await import("../dist/sandbox/apply.js");
    await prepareFolder(policy, support, later);
    const ran = commit();
    assert.equal(ran.stdout.trim(), "later", ran.stderr);
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

  await t.test("the sandbox's tools follow the switch each time they are loaded, so a reload reaches open chats", async () => {
    const { sandboxTools } = await import("../dist/sandbox/tools.js");
    const names = (factory) => {
      const got = [];
      factory({ registerTool: (t) => got.push(t.name) });
      return got.sort();
    };
    const fakePi = new Proxy({}, { get: (_, key) => (_cwd) => ({ name: String(key).replace(/^create(\w+)ToolDefinition$/, "$1").toLowerCase() }) });
    const factory = await sandboxTools(fakePi, path.join(WORK, "project"));
    assert.deepEqual(names(factory), ["bash", "edit", "grep", "ls", "read", "write"]);
    saveSandboxPolicy({ ...policy, enabled: false });
    assert.deepEqual(names(factory), [], "switched off: the built-ins stay");
    saveSandboxPolicy(policy);
    assert.equal(names(factory).length, 6, "and on again");
  });

  await t.test("switched off, the search wrappers run as the portal again and nothing else changes", async () => {
    const off = await applySandbox({ ...policy, enabled: false }, support, false);
    assert.equal(off.ok, true);
    assert.equal(existsSync(path.join(DATA, "sandbox", "enabled")), false);
  });
});
