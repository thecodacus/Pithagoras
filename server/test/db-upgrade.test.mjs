import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, writeSync, closeSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const home = mkdtempSync(path.join(tmpdir(), "pithagoras-upgrade-"));
process.env.DATA_DIR = home;

const { DamagedDatabase, backupsIn, integrityProblems, pruneBackups, runUpgrade } = await import("../dist/db-upgrade-steps.js");
const { SCHEMA_VERSION } = await import("../dist/schema-version.js");
const { upgradeCheck } = await import("../dist/db-upgrade.js");

/** A database as an older portal left it: sessions and events, no version. */
function oldDatabase(file, rows = 2000) {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle');
          CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  d.prepare("INSERT INTO sessions (id, title, workspace) VALUES ('s1', 'kept', '/tmp')").run();
  const add = d.prepare("INSERT INTO events (session_id, type, payload) VALUES ('s1', 'message', ?)");
  d.transaction(() => { for (let i = 0; i < rows; i++) add.run(JSON.stringify({ text: "x".repeat(200), i })); })();
  d.close();
}
const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
/** Overwrites a page in the middle of the file: a table's pages, not the header. */
function damage(file) {
  const fd = openSync(file, "r+");
  writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096 * 20);
  closeSync(fd);
}
const fresh = (name) => { const dir = path.join(home, name); mkdirSync(dir, { recursive: true }); return { dir, file: path.join(dir, "portal.db") }; };

test("a new install needs no upgrade; an old database does, from version 0", () => {
  const a = fresh("check");
  assert.deepEqual(upgradeCheck(a.file), { needed: false, from: 0 });
  oldDatabase(a.file, 10);
  assert.deepEqual(upgradeCheck(a.file), { needed: true, from: 0 });
});

test("a healthy database is backed up, then upgraded, and the copy holds what was there", async () => {
  const a = fresh("healthy");
  oldDatabase(a.file);
  const said = [];
  let migrated = false;
  const backup = await runUpgrade({ file: a.file, from: 0, backupDir: path.join(a.dir, "backups"), migrate: async () => {
    const d = new Database(a.file); d.pragma(`user_version = ${SCHEMA_VERSION}`); d.close(); migrated = true;
  } }, (m) => said.push(m));
  assert.ok(migrated);
  assert.ok(backup && existsSync(backup));
  const copy = new Database(backup, { readonly: true });
  assert.equal(copy.prepare("SELECT title FROM sessions").get().title, "kept");
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2000);
  copy.close();
  assert.ok(said.some((m) => m.startsWith("Checking")) && said.some((m) => m.startsWith("Backing up")) && said.at(-1).startsWith("Upgrading"));
  assert.equal(upgradeCheck(a.file).needed, false);
});

test("a damaged database is found before anything changes, and is not backed up", async () => {
  const a = fresh("damaged");
  oldDatabase(a.file);
  damage(a.file);
  assert.ok(integrityProblems(a.file).length > 0);
  const before = hash(a.file);
  let migrated = false;
  await assert.rejects(runUpgrade({ file: a.file, from: 0, backupDir: path.join(a.dir, "backups"), migrate: async () => { migrated = true; } }, () => {}),
    (e) => e instanceof DamagedDatabase && /damaged/.test(e.message));
  assert.equal(migrated, false);
  assert.equal(hash(a.file), before);
  assert.deepEqual(backupsIn(path.join(a.dir, "backups")), []);
});

test("with no room for the backup it refuses, and changes nothing", async () => {
  const a = fresh("full");
  oldDatabase(a.file, 50);
  let migrated = false;
  await assert.rejects(runUpgrade({ file: a.file, from: 0, backupDir: path.join(a.dir, "backups"), free: () => 0, migrate: async () => { migrated = true; } }, () => {}),
    /not room to back up/);
  assert.equal(migrated, false);
  assert.equal(upgradeCheck(a.file).needed, true);
});

test("only the newest backups are kept, and nothing else in the folder is touched", () => {
  const dir = fresh("prune").dir;
  const names = ["portal-v0-20260101-000000.db", "portal-v0-20260102-000000.db", "portal-v1-20260103-000000.db", "notes.txt"];
  names.forEach((n, i) => { const f = path.join(dir, n); writeFileSync(f, "x"); utimesSync(f, 1000 + i, 1000 + i); });
  pruneBackups(dir, 2);
  assert.ok(!existsSync(path.join(dir, names[0])));
  assert.ok(existsSync(path.join(dir, names[1])) && existsSync(path.join(dir, names[2])) && existsSync(path.join(dir, "notes.txt")));
});

/** Runs prepareDatabase() as the server would, in its own process, on a data folder and port of its own. */
function startUpgrade(dataDir, port) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(new URL("../dist/db-upgrade.js", import.meta.url).href)}); await m.prepareDatabase(); console.log("READY");`],
    { env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), PORTAL_PASSWORD: "", ALLOW_OPEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  return { child, output: () => out };
}
const until = async (ok, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test("a whole upgrade on startup: backed up, upgraded with the real migrations, then it returns", async () => {
  const a = fresh("startup");
  oldDatabase(a.file, 500);
  const run = startUpgrade(a.dir, 47000 + Math.floor(Math.random() * 1000));
  const exited = await new Promise((resolve) => run.child.on("exit", resolve));
  assert.equal(exited, 0, run.output());
  assert.match(run.output(), /READY/);
  assert.equal(upgradeCheck(a.file).needed, false);
  assert.equal(backupsIn(path.join(a.dir, "backups")).length, 1);
  const d = new Database(a.file, { readonly: true });
  assert.equal(d.prepare("SELECT title FROM sessions WHERE id = 's1'").get().title, "kept");
  d.close();
});

test("a damaged database on startup keeps the page up with how to repair it, rather than exiting", async () => {
  const a = fresh("startup-damaged");
  oldDatabase(a.file);
  damage(a.file);
  const port = 48000 + Math.floor(Math.random() * 1000);
  const run = startUpgrade(a.dir, port);
  try {
    assert.ok(await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/sessions`)).status === 500; } catch { return false; } }), run.output());
    const api = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    assert.match(api.error, /damaged/);
    assert.equal(api.upgrading, false);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /To repair it/);
    assert.match(html, /\.recover/);
    assert.equal(run.child.exitCode, null, "still running");
    assert.doesNotMatch(run.output(), /READY/);
  } finally {
    run.child.kill();
  }
});
