import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEnd, createLifecycleTracker, buildUnits } from '../lib/lifecycle.js';

const unit = (extra = {}) => ({ id: 'bot', sessionIds: ['s'], eligible: true, visible: true, busy: false, ...extra });
const start = (turn = 1, serial = turn * 2) => ({ sessionId: 's', phase: 'start', turn, serial });
const end = (outcome = 'completed', turn = 1) => ({ sessionId: 's', phase: 'end', outcome, turn, serial: turn * 2 + 1 });
const harness = () => {
  const tracker = createLifecycleTracker();
  const step = (at, extra = {}, signals = []) => tracker.advance({ units: [unit(extra)], signals }, at);
  return { tracker, step, run: () => step(0, { busy: true }, [start()]), settle: () => step(3000) };
};

for (const [reason, expected] of [
  [{ kind: 'completed' }, 'completed'], [{ kind: 'error', error: 'private text' }, 'error'],
  [{ kind: 'interrupted' }, 'error'], [{ kind: 'max-tokens' }, 'error'],
  [{ kind: 'aborted', reason: { kind: 'user' } }, 'interrupted'],
  [{ kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } }, 'interrupted'],
  [{ kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/steer' } }, null],
  [{ kind: 'aborted', reason: { kind: 'hook', reason: 'switch-part' } }, null],
  [{ kind: 'aborted', reason: { kind: 'shutdown' } }, null], [undefined, null],
]) test(`end classification: ${JSON.stringify(reason)}`, () => assert.equal(classifyEnd(reason), expected));

test('initial idle snapshots never replay old completion', () => { const h = harness(); assert.deepEqual(h.step(0), []); assert.deepEqual(h.step(100000), []); });
test('text/tool running edges stay silent while the real turn is open', () => { const h = harness(); h.run(); for (let n = 1; n <= 8; n++) assert.deepEqual(h.step(n * 1200, { busy: true }), []); });
test('completed requires terminal signal and two stable snapshots', () => { const h = harness(); h.run(); assert.deepEqual(h.step(1000, {}, [end()]), []); assert.deepEqual(h.step(2000), []); assert.equal(h.step(3000)[0].kind, 'completed'); assert.deepEqual(h.step(10000), []); });
test('native idle with no terminal event is never success', () => { const h = harness(); h.run(); assert.deepEqual(h.step(1000), []); assert.deepEqual(h.step(5000), []); });
test('a missing terminal event eventually raises error', () => { const h = harness(); h.run(); h.step(1000); h.step(16000); assert.equal(h.step(18000)[0].kind, 'error'); });
test('end of one turn still waiting for delegated work stays silent', () => { const h = harness(); h.run(); h.step(1000, { waiting: true }, [end()]); assert.deepEqual(h.step(100000, { waiting: true }), []); h.step(101000, { busy: true }, [start(2)]); h.step(102000, {}, [end('completed', 2)]); assert.equal(h.step(104000)[0].kind, 'completed'); });
test('approval or question blocks completion', () => { const h = harness(); h.run(); h.step(1000, { userPending: true }, [end()]); assert.deepEqual(h.step(20000, { userPending: true }), []); });
test('transient error followed by retry produces only final success', () => { const h = harness(); h.run(); h.step(1000, {}, [end('error')]); h.step(2000, { busy: true }, [start(2)]); h.step(4000, {}, [end('completed', 2)]); assert.equal(h.step(6000)[0].kind, 'completed'); });
for (const kind of ['error', 'interrupted']) test(`${kind} is distinct and notified once`, () => { const h = harness(); h.run(); h.step(1000, {}, [end(kind)]); assert.equal(h.step(3000)[0].kind, kind); assert.deepEqual(h.step(9000), []); });
test('internal steer cut is silent, fresh turn can complete', () => { const h = harness(); h.run(); h.step(1000, {}, [end(null)]); h.step(2000, { busy: true }, [start(2)]); h.step(3000, {}, [end('completed', 2)]); assert.equal(h.step(5000)[0].kind, 'completed'); });
test('rapid new task cancels previous settling timer', () => { const h = harness(); h.run(); h.step(1000, {}, [end()]); assert.deepEqual(h.step(2000, { busy: true }, [start(2)]), []); assert.deepEqual(h.step(5000, { busy: true }), []); });
test('second real task has a fresh notification cycle', () => { const h = harness(); h.run(); h.step(1000, {}, [end()]); const a = h.step(3000)[0]; h.step(4000, { busy: true }, [start(2)]); h.step(5000, {}, [end('completed', 2)]); const b = h.step(7000)[0]; assert.ok(b.cycle > a.cycle); });
test('short reconnect is silent and does not replay completion', () => { const h = harness(); h.run(); h.tracker.advance({ healthy: false }, 1000); assert.deepEqual(h.tracker.advance({ healthy: false }, 7000), []); assert.deepEqual(h.step(8000, { busy: true }), []); });
test('persistent disconnect during work errors once, no success after reconnect', () => { const h = harness(); h.run(); h.tracker.advance({ healthy: false }, 1000); assert.equal(h.tracker.advance({ healthy: false }, 9000)[0].kind, 'error'); assert.deepEqual(h.tracker.advance({ healthy: false }, 10000), []); h.step(11000, {}, [end()]); assert.deepEqual(h.step(14000), []); });
test('idle disconnect does not sound', () => { const h = harness(); h.step(0); h.tracker.advance({ healthy: false }, 1000); assert.deepEqual(h.tracker.advance({ healthy: false }, 20000), []); });
test('waiting for the user is not a failed work disconnect', () => { const h = harness(); h.run(); h.step(500, { userPending: true }); h.tracker.advance({ healthy: false }, 1000); assert.deepEqual(h.tracker.advance({ healthy: false }, 20000), []); });
test('delegated waiting still warns when disconnected', () => { const h = harness(); h.run(); h.step(500, { waiting: true }); h.tracker.advance({ healthy: false }, 1000); assert.equal(h.tracker.advance({ healthy: false }, 9000)[0].kind, 'error'); });
test('parallel Bots finishing together both notify instead of global cooldown loss', () => { const t = createLifecycleTracker(); const units = [unit(), unit({ id: 'b2', sessionIds: ['s2'] })]; t.advance({ units: units.map(u => ({ ...u, busy: true })) }, 0); t.advance({ units, signals: [end(), { ...end('error'), sessionId: 's2' }] }, 1000); assert.equal(t.advance({ units }, 3000).length, 2); });
test('deleted unit is discarded without an inferred completion', () => { const h = harness(); h.run(); assert.deepEqual(h.tracker.advance({ units: [] }, 10000), []); });
test('scope visibility is attached to outcome', () => { const h = harness(); h.run(); h.step(1000, { visible: false }, [end()]); assert.equal(h.step(3000, { visible: false })[0].visible, false); });

test('DS Bot work remains busy even when native running flaps off', () => { const units = buildUnits({ bots: [{ id: 'bot', sessionId: 's' }], work: { bots: { bot: { since: 1 } } } }, new Map([['s', { running: false }]]), {}); assert.equal(units[0].busy, true); });
test('DS Bot turn clock and part-switch also block premature completion', () => { const state = { bots: [{ id: 'bot', sessionId: 's' }], work: { turns: { s: 12 } } }; assert.equal(buildUnits(state, new Map(), {})[0].busy, true); state.work = { bots: { bot: { switching: true } } }; assert.equal(buildUnits(state, new Map(), {})[0].busy, true); });
test('delegated waits, approvals and question cards mapped from public DS Bot state', () => { const state = { bots: [{ id: 'bot', sessionId: 's' }], questions: { s: true }, work: { waiting: { bot: { waits: ['other'] } } } }; const u = buildUnits(state, new Map(), {})[0]; assert.equal(u.waiting, true); assert.equal(u.userPending, true); });
test('subagents and blank sessions filtered; Bot parts not duplicated', () => { const rows = { child: { origin: 'subagent' }, blank: { blank: true }, old: {}, s: {}, native: {} }; const state = { bots: [{ id: 'bot', sessionId: 's', parts: ['old'] }] }; assert.deepEqual(buildUnits(state, new Map(), rows).map(x => x.id), ['bot', 'native']); });
test('group with working member stays busy; hidden member parts not duplicated', () => { const state = { rooms: [{ id: 'room', parts: ['r1'], sessionId: 'r' }], work: { rooms: { room: [{ botId: 'bot' }] } } }; const units = buildUnits(state, new Map(), { r1: {}, r: {} }); assert.equal(units.length, 1); assert.equal(units[0].busy, true); });
test('null pendingInteraction is idle, not an unanswered interaction', () => { assert.equal(buildUnits(null, new Map([['s', { pendingInteraction: null }]]), { s: {} })[0].userPending, false); });
test('group-only work does not arm an idle own-chat Bot', () => { const state = { bots: [{ id: 'b', sessionId: 's' }], work: { bots: { b: { roomId: 'room' } } } }; assert.equal(buildUnits(state, new Map(), {})[0].busy, false); });
test('dismissed question card does not play a stale completion', () => { const h = harness(); h.run(); h.step(1000, { userPending: true }, [end()]); assert.deepEqual(h.step(10000), []); assert.deepEqual(h.step(30000), []); });
