import { randomUUID } from 'node:crypto';
import { classifyEnd } from './lifecycle.js';

/** Only in-memory lifecycle metadata; no chat text, errors, prompts or files. */
export function createJournal({ limit = 1024, epoch = randomUUID(), startedAt = Date.now() } = {}) {
  let cursor = 0;
  const entries = [];
  const seen = new Map();
  return {
    record(session, event) {
      if (!session?.id || !['turn/start', 'turn/end'].includes(event?.type)) return;
      // Session hydration may replay old history after a client has baselined.
      if (typeof event.time === 'number' && event.time < startedAt) return;
      const key = `${event.seq}:${event.type}`;
      if (seen.get(session.id) === key) return;
      seen.delete(session.id);
      seen.set(session.id, key);
      if (seen.size > limit) seen.delete(seen.keys().next().value);
      entries.push({ serial: ++cursor, sessionId: session.id, turn: event.data?.turn,
        phase: event.type === 'turn/start' ? 'start' : 'end',
        ...(event.type === 'turn/end' ? { outcome: classifyEnd(event.data?.reason) } : {}) });
      if (entries.length > limit) entries.shift();
    },
    snapshot(since, fromEpoch) {
      const baseline = fromEpoch !== epoch || !Number.isSafeInteger(since) || since < 0;
      return { epoch, cursor, reset: baseline, gap: !baseline && since < (entries[0]?.serial ?? cursor + 1) - 1,
        events: baseline ? [] : entries.filter(entry => entry.serial > since) };
    },
  };
}
