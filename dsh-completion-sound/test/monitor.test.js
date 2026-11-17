import test from 'node:test';
import assert from 'node:assert/strict';
import { startLifecycleMonitor } from '../lib/monitor.js';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture(reply) {
  let serial = 0;
  const timers = new Map(), frames = [], requests = [];
  const stop = startLifecycleMonitor({
    fetch: async (url, opts) => { requests.push({ url, opts }); return reply(url, opts, requests); },
    getNative: () => ({ statuses: new Map(), sessions: { byId: { s: {} } } }),
    onFrame: frame => frames.push(frame),
    schedule: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; }, cancel: id => timers.delete(id),
  });
  const next = async () => { await flush(); const pair = [...timers].find(([, t]) => t.ms === 1000); assert.ok(pair); timers.delete(pair[0]); pair[1].fn(); await flush(); };
  return { frames, requests, stop, next, timers };
}
const response = body => ({ ok: true, json: async () => body });
const journal = { epoch: 'e', cursor: 0, events: [], reset: true };
const state = { bots: [{ id: 'b', sessionId: 's', name: 'discard', instructions: 'discard' }], work: { bots: { b: { since: 1 } } }, revision: 1, liveKey: 'l' };

test('monitor reads metadata then DS Bot state before publishing', async () => {
  const f = fixture(url => response(url.startsWith('api/completion') ? journal : { ok: true, value: state })); await flush();
  assert.equal(f.requests.length, 2); assert.equal(f.frames[0].units[0].id, 'b'); assert.equal(f.frames[0].units[0].busy, true); assert.ok(!JSON.stringify(f.frames).includes('discard'));
  await f.next(); assert.match(f.requests[2].url, /epoch=e&since=0/); const payload = JSON.parse(f.requests[3].opts.body).payload; assert.equal(payload.since, 1); assert.equal(payload.live, 'l'); f.stop(); assert.equal(f.timers.size, 0);
});
test('unchanged DS Bot responses retain roster and work', async () => { let n = 0; const f = fixture(url => response(url.startsWith('api/completion') ? journal : { ok: true, value: ++n === 1 ? state : { unchanged: true, liveKey: 'l' } })); await flush(); await f.next(); assert.equal(f.frames[1].units[0].busy, true); f.stop(); });
test('missing DS Bot falls back to native sessions', async () => { const f = fixture(url => url.startsWith('api/completion') ? response(journal) : { ok: false, status: 404 }); await flush(); assert.equal(f.frames[0].healthy, true); assert.equal(f.frames[0].units[0].id, 's'); f.stop(); });
test('network failure is an unhealthy frame, never a successful end', async () => { const f = fixture(() => { throw new Error('offline'); }); await flush(); assert.deepEqual(f.frames, [{ healthy: false }]); f.stop(); });
test('journal cursor is retained on failed state query so events can be retried', async () => { let n = 0; const f = fixture(url => { if (url.startsWith('api/completion')) return response(journal); if (++n === 1) throw new Error('offline'); return response({ ok: true, value: state }); }); await flush(); await f.next(); assert.equal(f.requests[2].url, 'api/completion-sound/lifecycle'); assert.equal(f.frames[1].healthy, true); f.stop(); });
test('cursor gaps suppress success and permit recovery at next cursor', async () => { const f = fixture(url => response(url.startsWith('api/completion') ? { ...journal, gap: true } : { ok: true, value: state })); await flush(); assert.equal(f.frames[0].healthy, false); f.stop(); });
test('disposed monitor publishes nothing and does not reschedule', async () => { let release; const f = fixture(() => new Promise(resolve => { release = resolve; })); f.stop(); release(response(journal)); await flush(); assert.deepEqual(f.frames, []); assert.equal(f.timers.size, 0); });
