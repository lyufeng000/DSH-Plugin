// Exercise the actual installed DSH router over real loopback HTTP, with an isolated registry.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../index.js';
import { startLifecycleMonitor } from '../lib/monitor.js';
import { createLifecycleTracker } from '../lib/lifecycle.js';
const checkout = process.argv[2];
if (!checkout) throw new Error('Pass the DSH checkout directory');
const { HostConnectionService } = await import(pathToFileURL(join(checkout, 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')));
const proto = HostConnectionService.prototype;
const disposers = [];
const owner = { effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off); return off; } };
const service = { fetchRoutes: new Map(), interceptors: new Map() };
const register = route => proto.registerFetchRoute.call(service, owner, route);
// The original bug MUST fail the real Host validator, not just a test fake.
assert.throws(() => register({ path: 'api/completion-sound/lifecycle', methods: ['GET'], requestBody: 'buffered', fetch: () => new Response('{}') }), /invalid exact Fetch route/);
let event;
const scope = { ...owner, connection: { fetch: { register } } };
apply({ on: (_name, fn) => { event = fn; }, inject: (_deps, fn) => fn(scope) });
let busy = true;
register({ path: '/api/bot', methods: ['POST'], requestBody: 'buffered', fetch: () => new Response(JSON.stringify({ ok: true, value: {
  bots: [{ id: 'fixture-bot', sessionId: 'fixture-session' }], rooms: [], questions: {}, views: {},
  work: { bots: busy ? { 'fixture-bot': { since: 1 } } : {}, turns: {}, waiting: {}, approvals: [] },
} }), { headers: { 'content-type': 'application/json' } }) });
const router = proto.createSharedFetchHandler.call(service, '/api');
const server = createServer(async (req, res) => {
  try {
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method });
    const response = await router.fetch(request, { principal: { kind: 'owner' } });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
let stop;
try {
  const probe = await fetch(`${base}api/completion-sound/lifecycle`);
  assert.equal(probe.status, 200);
  const first = await probe.json(); assert.ok(first.epoch);
  const denied = await router.fetch(new Request(`${base}api/completion-sound/lifecycle`), { principal: { kind: 'guest' } });
  assert.equal(denied.status, 403);
  let seq = 0, turn = 1, stage = 'initial';
  const expected = ['completed', 'error', 'interrupted'], got = [];
  const tracker = createLifecycleTracker({ settleMs: 0 });
  const publish = (type, kind) => event({ id: 'fixture-session' }, { type, seq: ++seq, time: Date.now(), data: { turn, reason: kind === 'interrupted' ? { kind: 'aborted', reason: { kind: 'user' } } : { kind } } });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { stop?.(); reject(new Error(`Monitor did not deliver ${expected.join(',')}: ${got.join(',')}`)); }, 8000);
    stop = startLifecycleMonitor({
      fetch: (path, opts) => fetch(new URL(path, base), opts), pollMs: 5,
      getNative: () => ({ statuses: new Map([['fixture-session', { running: busy }]]), sessions: { byId: { 'fixture-session': {} } } }),
      onFrame: frame => {
        try {
          assert.equal(frame.healthy, true);
          const notices = tracker.advance(frame, Date.now());
          if (stage === 'initial') { busy = false; publish('turn/end', 'completed'); stage = 'ending'; }
          else if (stage === 'running') { busy = false; publish('turn/end', expected[got.length]); stage = 'ending'; }
          for (const notice of notices) {
            assert.equal(notice.kind, expected[got.length]); got.push(notice.kind);
            if (got.length === expected.length) { stop(); clearTimeout(deadline); resolve(); return; }
            busy = true; turn++; publish('turn/start'); stage = 'running';
          }
        } catch (error) { stop?.(); clearTimeout(deadline); reject(error); }
      },
    });
  });
  console.log(JSON.stringify({ realHostRouter: 'PASS', oldPathNegativeControl: 'PASS', ownerFence: 'PASS', httpMonitorOutcomes: got, registeredPath: '/api/completion-sound/lifecycle' }));
} finally {
  stop?.(); for (const off of disposers.reverse()) off();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
