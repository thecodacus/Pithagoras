import assert from 'node:assert/strict';
import http from 'node:http';
import { after } from 'node:test';

/** One request to the fake daemon, parsed. `res` is for an answer that goes out in parts: return 'handled' after it. */
export interface DockerCall {
  method: string;
  /** The whole request URL, query included, as the portal sent it. */
  url: string;
  path: string;
  query: URLSearchParams;
  body: any;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

/** What the daemon answers: a status (200 unless said) with JSON or text, or 'handled' when `res` was used. */
export type DockerReply = { status?: number; json?: unknown; text?: string } | 'handled' | undefined;

/**
 * A Docker daemon on a socket of its own, for a test of what the portal asks of Docker. `answer` says what it answers to
 * each call. A call it returns nothing for is one the test did not expect, so the daemon answers it 500 instead of
 * something that makes it pass, and keeps it in `unexpected`: a wrong or new call (a stray DELETE of a volume) fails
 * where it is made, with its name in the message, and the file's tests end in a failure that lists them. Every call,
 * expected or not, is in `calls`.
 */
export async function fakeDocker(socket: string, answer: (call: DockerCall) => DockerReply | Promise<DockerReply>) {
  const calls: { method: string; url: string; body: any }[] = [];
  const unexpected: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const url = req.url!;
    const call: DockerCall = { method: req.method!, url, path: url.split('?')[0], query: new URL(url, 'http://docker').searchParams, body: raw ? JSON.parse(raw) : undefined, req, res };
    calls.push({ method: call.method, url, body: call.body });
    res.setHeader('Content-Type', 'application/json');
    const reply = await answer(call);
    if (reply === 'handled') return;
    if (reply === undefined) {
      unexpected.push(`${call.method} ${url}`);
      res.statusCode = 500;
      return res.end(JSON.stringify({ message: `the fake Docker has no answer for ${call.method} ${url}` }));
    }
    res.statusCode = reply.status ?? 200;
    res.end(reply.text ?? (reply.json === undefined ? '{}' : JSON.stringify(reply.json)));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    assert.deepEqual(unexpected, [], 'calls the fake Docker had no answer for');
  });
  return {
    calls, unexpected,
    /** The calls as `METHOD url` lines, for a test that compares them as text. */
    asked: () => calls.map((c) => `${c.method} ${c.url}`),
    /** Forgets the calls so far, as a test that begins fresh. What was unexpected stays: it is a failure all the same. */
    reset() { calls.length = 0; },
  };
}
