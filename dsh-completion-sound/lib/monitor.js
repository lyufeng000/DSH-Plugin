import { buildUnits } from './lifecycle.js';

/** Poll the existing read-only DS Bot state API, alongside our metadata cursor. */
export function startLifecycleMonitor({ fetch, getNative, onFrame, schedule = setTimeout, cancel = clearTimeout, pollMs = 1000, timeoutMs = 4000 }) {
  let stopped = false;
  let timer;
  let controller;
  let epoch;
  let cursor;
  let botState = null;
  let botKnown = false;
  let revision;
  let models;
  let live;
  const json = async (path, options) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return response.json();
  };
  const pullBots = async () => {
    try {
      const result = await json('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'state', payload: { since: revision, models, live } }) });
      if (result.ok !== true) {
        if (!botKnown && result.error?.code === 'bot/not-found') return;
        throw new Error('DS Bot state query failed');
      }
      const value = result.value;
      // Consume only status fields, not messages, prompts, credentials or previews.
      botKnown = true;
      const next = { ...(botState ?? {}) };
      if (value.bots) next.bots = value.bots.map(({ id, sessionId, parts }) => ({ id, sessionId, parts }));
      if (value.rooms) next.rooms = value.rooms.map(({ id, sessionId, parts, ownParts }) => ({ id, sessionId, parts, ownParts }));
      for (const key of ['work', 'questions', 'views']) if (value[key] !== undefined) {
        next[key] = key === 'work' ? value[key] : Object.fromEntries(Object.keys(value[key] ?? {}).map(id => [id, true]));
      }
      botState = next;
      revision = value.revision ?? revision;
      models = value.modelsKey ?? models;
      live = value.liveKey ?? live;
    } catch (error) {
      if (!botKnown && (error.status === 404 || error.status === 405)) return;
      throw error;
    }
  };
  async function poll() {
    if (stopped) return;
    controller = new AbortController();
    const timeout = schedule(() => controller.abort(), timeoutMs);
    try {
      const query = epoch === undefined ? '' : `?epoch=${encodeURIComponent(epoch)}&since=${cursor}`;
      // A terminal event followed by a newer state is safe; the reverse can falsely settle.
      const journal = await json(`api/completion-sound/lifecycle${query}`, { method: 'GET' });
      if (stopped) return;
      await pullBots();
      if (stopped) return;
      epoch = journal.epoch;
      cursor = journal.cursor;
      const native = getNative();
      onFrame({ healthy: !journal.gap, units: buildUnits(botState, native.statuses, native.sessions?.byId), signals: journal.events ?? [] });
    } catch {
      if (!stopped) onFrame({ healthy: false });
    } finally {
      cancel(timeout);
      if (!stopped) timer = schedule(poll, pollMs);
    }
  }
  void poll();
  return () => { stopped = true; cancel(timer); controller?.abort(); };
}
