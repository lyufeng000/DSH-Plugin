import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../lib/journal.js';
import { apply } from '../index.js';
const event = (seq, type, reason) => ({ seq, type, time: Date.now(), data: { turn: 1, reason } });

test('new client baselines cursor; never replays previous ends', () => { const j = createJournal({ epoch: 'e' }); j.record({ id: 's' }, event(1, 'turn/end', { kind: 'completed' })); assert.deepEqual(j.snapshot(undefined).events, []); assert.equal(j.snapshot(undefined).cursor, 1); });
test('records starts and terminal reason, not message or error content', () => { const j = createJournal({ epoch: 'e' }); j.record({ id: 's' }, event(1, 'assistant/message')); j.record({ id: 's' }, event(2, 'turn/start')); j.record({ id: 's' }, event(3, 'turn/end', { kind: 'error', error: { secret: 'MUST_NOT_LEAK' } })); const snap = j.snapshot(0, 'e'); assert.equal(snap.events.length, 2); assert.equal(snap.events[1].outcome, 'error'); assert.ok(!JSON.stringify(snap).includes('MUST_NOT_LEAK')); });
test('bounded journal reports a cursor gap and resets across epochs', () => { const j = createJournal({ epoch: 'e', limit: 2 }); for (let i = 0; i < 4; i++) j.record({ id: 's' }, event(i, 'turn/start')); assert.equal(j.snapshot(0, 'e').gap, true); assert.equal(j.snapshot(2, 'e').gap, false); assert.deepEqual(j.snapshot(0, 'old').events, []); });
test('duplicate delivery is ignored', () => { const j = createJournal({ epoch: 'e' }); const e = event(1, 'turn/end', { kind: 'completed' }); j.record({ id: 's' }, e); j.record({ id: 's' }, e); assert.equal(j.snapshot(0, 'e').events.length, 1); });
test('host registers read-only lifecycle API and observer, with disposal', async () => {
  let listen, route;
  const disposers = [];
  let disposed = false;
  const scope = { connection: { fetch: { register: r => { route = r; return () => { disposed = true; }; } } }, effect: fn => { const off = fn(); disposers.push(off); } };
  apply({ on: (name, cb) => { assert.equal(name, 'session/event'); listen = cb; }, inject: (deps, fn) => { assert.deepEqual(deps, ['connection']); scope.stop = fn(scope); } });
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.path, '/api/completion-sound/lifecycle');
  assert.equal(new URL('http://local/api/completion-sound/lifecycle').pathname, route.path);
  const initial = await (await route.fetch(new Request('http://local/api/completion-sound/lifecycle'))).json();
  listen({ id: 's' }, event(1, 'turn/end', { kind: 'aborted', reason: { kind: 'user' } }));
  const res = await route.fetch(new Request(`http://local/api/completion-sound/lifecycle?epoch=${initial.epoch}&since=${initial.cursor}`));
  const next = await res.json(); assert.equal(next.events[0].outcome, 'interrupted');
  disposers.forEach(off => off());
  assert.equal(disposed, true);
});
test('late hydration of historical events never arms a fresh notification', () => {
  const j = createJournal({ epoch: 'e', startedAt: 1000 });
  j.record({ id: 's' }, { ...event(1, 'turn/end', { kind: 'completed' }), time: 900 });
  assert.equal(j.snapshot(0, 'e').events.length, 0);
});
