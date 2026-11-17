import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('built watcher carries three real API outcomes all the way to Web Audio starts', async () => {
  let clock = 0, nextTimer = 0, module, busy = true, cursor = 0;
  const timers = new Map(), effects = [], disposers = [], slots = new Map(), events = [], started = [];
  const statuses = new Map([['s', { running: true }]]);
  const schedule = (fn, ms) => { timers.set(++nextTimer, { fn, at: clock + ms }); return nextTimer; };
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const tick = async target => {
    await flush();
    for (;;) {
      const ready = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!ready) break;
      clock = ready[1].at; timers.delete(ready[0]); ready[1].fn(); await flush();
    }
    clock = target; await flush();
  };
  const param = () => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    state = 'running'; currentTime = 0; destination = {};
    createGain() { return { ...node(), gain: param() }; }
    createOscillator() { let frequency; return { ...node(), frequency: { setValueAtTime(v) { frequency = v; } }, start() { started.push(frequency); }, stop() {} }; }
  }
  const React = { createElement() {}, useRef: value => ({ current: value }), useEffect: fn => effects.push(fn) };
  const window = {
    __ModuleLoader__: { load: entry => { module = entry.factory(() => React); } },
    AudioContext, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {},
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    fetch: async path => ({ ok: true, json: async () => {
      if (path.startsWith('api/completion-sound/')) {
        const url = new URL(path, 'http://fixture/'); const since = url.searchParams.get('since');
        return { epoch: 'e', cursor, events: since === null ? [] : events.filter(e => e.serial > Number(since)) };
      }
      return { ok: true, value: { bots: [{ id: 'bot', sessionId: 's' }], rooms: [], questions: {}, views: {}, work: { bots: busy ? { bot: {} } : {}, turns: {}, waiting: {}, approvals: [] } } };
    } }),
  };
  class Clock extends Date { static now() { return clock; } }
  vm.runInNewContext(source, { window, Date: Clock, AbortController, setTimeout: schedule, clearTimeout: id => timers.delete(id) });
  module.apply({ effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off); }, locale: { register() {} }, slots: { inject: (_name, fn) => fn(), register: (meta, component) => slots.set(meta.name, component) } });
  slots.get('shell.overlay')({ useSessionStatus: pick => pick(statuses), useSessions: pick => pick({ byId: { s: {} } }) });
  for (const effect of effects) { const off = effect(); if (typeof off === 'function') disposers.push(off); }
  const add = (phase, outcome, turn) => events.push({ serial: ++cursor, sessionId: 's', phase, outcome, turn });
  await flush();
  // Native props can lag; DS Bot work is authoritative across all these steps.
  for (const [kind, turn, base, count] of [['completed', 1, 0, 3], ['error', 2, 4000, 5], ['interrupted', 3, 8000, 8]]) {
    if (turn > 1) { busy = true; statuses.set('s', { running: true }); add('start', undefined, turn); await tick(base + 1000); }
    busy = false; statuses.set('s', { running: false }); add('end', kind, turn);
    // Update the shared native snapshot independently from the DS Bot API.
    await tick(base + 4000);
    assert.equal(started.length, count, `${kind} reached the speaker exactly once`);
  }
  disposers.reverse().forEach(off => off());
  assert.equal(timers.size, 0);
});
