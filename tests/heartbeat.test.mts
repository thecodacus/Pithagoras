import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const temp = mkdtempSync(join(tmpdir(), 'pitha-heartbeat-'));
process.env.DATA_DIR = temp;
process.env.AGENT_HOME = join(temp, 'agent-home');
process.env.PI_CODING_AGENT_DIR = join(temp, 'agent');
process.env.SESSION_DIR = join(temp, 'sessions');

const { inQuietHours, heartbeatDue, setHeartbeat, heartbeat, WATCH_FILE } = await import('../server/src/heartbeat.ts');
const { createAgent, getAgent } = await import('../server/src/agents.ts');
const { addNote } = await import('../server/src/activity.ts');
const { agentsRouter } = await import('../server/src/api/agents.ts');
const { guardExtension } = await import('../server/src/pi/guard.ts');
const { HEARTBEAT_ROLE, NOTE_TOOL } = await import('../server/src/pi/heartbeat-names.ts');
const { addToolRule, getDb } = await import('../server/src/db.ts');
test.after(() => { getDb().close(); rmSync(temp, { recursive: true, force: true }); });

const at = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return new Date(2026, 9, 2, h, m); };

test('quiet hours hold within a day and across midnight, and are none without both ends', () => {
  assert.equal(inQuietHours(at('13:00'), '12:00', '14:00'), true);
  assert.equal(inQuietHours(at('14:00'), '12:00', '14:00'), false, 'the end is not quiet');
  assert.equal(inQuietHours(at('23:30'), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at('06:59'), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at('07:00'), '22:00', '07:00'), false);
  assert.equal(inQuietHours(at('12:00'), '22:00', '07:00'), false);
  assert.equal(inQuietHours(at('23:30'), '22:00', null), false);
  assert.equal(inQuietHours(at('23:30'), null, null), false);
});

test('a look is due once the interval has passed, never when off, and not in quiet hours', () => {
  const base = { heartbeat_minutes: 60, quiet_start: null, quiet_end: null, last_heartbeat: null } as any;
  const now = at('12:00');
  assert.equal(heartbeatDue({ ...base, heartbeat_minutes: null }, now), false);
  assert.equal(heartbeatDue(base, now), true, 'never looked yet');
  assert.equal(heartbeatDue({ ...base, last_heartbeat: at('11:30').toISOString() }, now), false);
  assert.equal(heartbeatDue({ ...base, last_heartbeat: at('11:00').toISOString() }, now), true);
  assert.equal(heartbeatDue({ ...base, quiet_start: '11:00', quiet_end: '13:00' }, now), false);
});

test('the settings are checked: an interval in range, and quiet hours as two times or none', () => {
  const agent = createAgent({ name: 'Watcher' });
  assert.equal(setHeartbeat(agent.id, { minutes: 120, quietStart: '22:00', quietEnd: '07:00' }).heartbeat_minutes, 120);
  assert.throws(() => setHeartbeat(agent.id, { minutes: 5 }), /every 15 minutes/);
  assert.throws(() => setHeartbeat(agent.id, { minutes: 60, quietStart: '22:00' }), /start and an end/);
  assert.throws(() => setHeartbeat(agent.id, { minutes: 60, quietStart: '25:00', quietEnd: '07:00' }), /times like/);
  const off = setHeartbeat(agent.id, { minutes: 0 });
  assert.equal(off.heartbeat_minutes, null);
  assert.equal(off.quiet_start, null);
});

test('a heartbeat can read and leave notes, and nothing else unless a rule for its role says so', () => {
  const handlers: Record<string, any> = {};
  guardExtension('test', () => ({ role: HEARTBEAT_ROLE }))({ on: (type: string, fn: any) => (handlers[type] = fn) });
  const call = (toolName: string, input: object) => handlers.tool_call({ toolName, input });
  assert.equal(call('read', { path: 'WATCH.md' }), undefined);
  assert.equal(call(NOTE_TOOL, { title: 'x', detail: 'y' }), undefined);
  for (const [tool, input] of [['bash', { command: 'gh pr list' }], ['write', { path: 'x' }], ['edit', { path: 'x' }], ['routine_create', {}]] as const) {
    assert.equal(call(tool, input)?.block, true, tool);
  }
  addToolRule({ id: 'hb-gh', role: HEARTBEAT_ROLE, tool: 'bash', pattern: 'gh pr list*', note: '', person_key: null });
  assert.equal(call('bash', { command: 'gh pr list --state open' }), undefined, 'allowed by a rule for its role');
  assert.equal(call('bash', { command: 'gh pr merge 3' })?.block, true);
});

test('a look with nothing to watch says so, and waits its interval', async () => {
  const agent = createAgent({ name: 'Idle' });
  setHeartbeat(agent.id, { minutes: 60 });
  const after = await heartbeat.run(getAgent(agent.id)!, 'manual');
  assert.match(after.heartbeat_status ?? '', new RegExp(`${WATCH_FILE} is empty`));
  assert.ok(after.last_heartbeat, 'the look counts, so it is not tried again on the next tick');
  assert.equal(heartbeatDue(after, new Date()), false);
});

test('the routes set the heartbeat and read, mark and delete its notes', async () => {
  const agent = createAgent({ name: 'Scout' });
  writeFileSync(join(agent.home, WATCH_FILE), 'The open PRs on the repo.\n');
  addNote(agent.id, null, 'A PR has been waiting a week', 'thecodacus/pithagoras#9');
  const second = addNote(agent.id, null, 'CI failing on main', 'The server job.');
  const app = express();
  app.use(express.json());
  app.use('/api', agentsRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/agents/${agent.id}`;
  const call = async (method: string, path: string, body?: object) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const set = await call('PUT', '/heartbeat', { minutes: 60, quietStart: '22:00', quietEnd: '07:00' });
    assert.equal(set.status, 200);
    assert.deepEqual([set.body.heartbeat.minutes, set.body.heartbeat.quietStart, set.body.heartbeat.watching], [60, '22:00', true]);
    assert.equal(set.body.unread, 2);
    assert.equal((await call('PUT', '/heartbeat', { minutes: 1 })).status, 400);

    const listed = await call('GET', '/activity');
    assert.deepEqual(listed.body.notes.map((n: any) => n.title), ['CI failing on main', 'A PR has been waiting a week']);
    assert.equal((await call('POST', '/activity/read')).body.unread, 0);
    assert.equal((await call('GET', '/activity')).body.unread, 0);
    assert.equal((await call('DELETE', `/activity/${second.id}`)).status, 200);
    assert.equal((await call('DELETE', `/activity/${second.id}`)).status, 404);
    assert.equal((await call('GET', '/activity')).body.notes.length, 1);
  } finally {
    server.close();
  }
});
