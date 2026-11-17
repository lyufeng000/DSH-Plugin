/** Pure state machine. Never infer success from a status edge or a text message. */
export function classifyEnd(reason) {
  if (reason?.kind === 'completed') return 'completed';
  if (reason?.kind === 'error' || reason?.kind === 'interrupted' || reason?.kind === 'max-tokens') return 'error';
  if (reason?.kind !== 'aborted') return null;
  const cause = reason.reason;
  if (cause?.kind === 'user' || (cause?.kind === 'hook' && cause.reason === 'ds-bot/stopped')) return 'interrupted';
  // Steering, part switching and other internal hooks are not user stops.
  return null;
}

export function createLifecycleTracker({ settleMs = 1800, disconnectMs = 8000, orphanMs = 15000 } = {}) {
  const records = new Map();
  let disconnectedAt = null;
  let cycle = 0;
  const make = id => ({ id, armed: false, notified: false, outcome: null, candidateAt: null, quietAt: null, samples: 0, startKey: null, cycle: ++cycle });
  function advance({ units = [], signals = [], healthy = true }, now) {
    const emitted = [];
    if (!healthy) {
      disconnectedAt ??= now;
      if (now - disconnectedAt >= disconnectMs) {
        for (const record of records.values()) {
          if (!record.armed || record.notified || record.userPending || !record.eligible) continue;
          record.notified = true;
          emitted.push({ id: record.id, kind: 'error', cycle: record.cycle, visible: record.visible, reason: 'connection-lost' });
        }
      }
      return emitted;
    }
    disconnectedAt = null;
    const byId = new Map(units.map(unit => [unit.id, unit]));
    const owners = new Map();
    for (const unit of units) for (const sid of unit.sessionIds ?? [unit.id]) owners.set(sid, unit.id);
    for (const unit of units) {
      let record = records.get(unit.id);
      if (!record) records.set(unit.id, record = make(unit.id));
      record.visible = unit.visible === true;
      record.eligible = unit.eligible !== false;
      record.userPending = unit.userPending === true;
      record.pending = unit.waiting === true || record.userPending;
    }
    for (const signal of signals) {
      const id = owners.get(signal.sessionId);
      if (!id) continue;
      const record = records.get(id);
      if (signal.phase === 'start') {
        const key = `${signal.sessionId}:${signal.turn}:${signal.serial}`;
        if (key !== record.startKey) {
          record.startKey = key;
          if (record.notified || !record.armed) record.cycle = ++cycle;
          record.armed = true;
          record.notified = false;
          record.outcome = null;
          record.candidateAt = null;
          record.quietAt = null;
          record.samples = 0;
        }
      } else if (signal.phase === 'end') {
        if (!record.armed && !record.notified) record.armed = true;
        // Latest turn owns the result, not an earlier retry or internal cut.
        record.outcome = signal.outcome;
        record.candidateAt = null;
        record.samples = 0;
      }
    }
    for (const unit of units) {
      const record = records.get(unit.id);
      if (unit.busy) {
        if (!record.armed && !record.notified) record.armed = true;
        record.candidateAt = null;
        record.quietAt = null;
        record.samples = 0;
        continue;
      }
      if (record.pending || !record.eligible) {
        if (record.userPending) { record.outcome = null; record.armed = false; }
        record.candidateAt = null;
        record.quietAt = null;
        record.samples = 0;
        continue;
      }
      if (!record.armed || record.notified) continue;
      record.quietAt ??= now;
      // A watched run disappearing without an end is a failure, never success.
      if (!record.outcome && now - record.quietAt >= orphanMs) record.outcome = 'error';
      if (!record.outcome) continue;
      record.candidateAt ??= now;
      record.samples += 1;
      if (record.samples < 2 || now - record.candidateAt < settleMs) continue;
      record.notified = true;
      emitted.push({ id: unit.id, kind: record.outcome, cycle: record.cycle, visible: record.visible });
    }
    for (const id of records.keys()) if (!byId.has(id)) records.delete(id);
    return emitted;
  }
  return { advance, reset: () => { records.clear(); disconnectedAt = null; } };
}

/** DS Bot 0.3.5 public state response + native Session snapshots. */
export function buildUnits(botState, statuses, sessionRows) {
  const units = [];
  const claimed = new Set();
  const statusOf = id => statuses?.get?.(id);
  const shown = ids => ids.some(id => (sessionRows?.[id]?.retainedBy?.mainView ?? 0) > 0);
  const pending = id => { const p = statusOf(id)?.pendingInteraction; return p !== undefined && p !== null; };
  const work = botState?.work ?? {};
  for (const bot of botState?.bots ?? []) {
    const ids = [...new Set([bot.id, bot.sessionId, ...(bot.parts ?? [])].filter(Boolean))];
    ids.forEach(id => claimed.add(id));
    const ownWork = work.bots?.[bot.id];
    const busy = Boolean(ownWork && !ownWork.roomId) || ids.some(id => statusOf(id)?.running === true || work.turns?.[id] !== undefined);
    const waiting = Boolean(work.waiting?.[bot.id]) || (work.approvals ?? []).some(entry => entry.botId === bot.id);
    units.push({ id: bot.id, sessionIds: ids, busy, waiting,
      userPending: ids.some(id => pending(id) || botState.questions?.[id] || botState.views?.[id]),
      eligible: true, visible: shown(ids) });
  }
  for (const room of botState?.rooms ?? []) {
    const ids = [...new Set([room.id, room.sessionId, ...(room.parts ?? []), ...(room.ownParts ?? [])].filter(Boolean))];
    ids.forEach(id => claimed.add(id));
    units.push({ id: room.id, sessionIds: ids,
      busy: (work.rooms?.[room.id]?.length ?? 0) > 0 || ids.some(id => statusOf(id)?.running === true || work.turns?.[id] !== undefined),
      waiting: Object.values(work.waiting ?? {}).some(entry => entry.rooms?.includes(room.id)) || (work.approvals ?? []).some(entry => entry.roomId === room.id),
      userPending: ids.some(id => pending(id) || botState.questions?.[id] || botState.views?.[id]),
      eligible: true, visible: shown(ids) });
  }
  for (const [id, row] of Object.entries(sessionRows ?? {})) {
    if (claimed.has(id) || row.origin === 'subagent' || row.blank === true) continue;
    units.push({ id, sessionIds: [id], busy: statusOf(id)?.running === true,
      waiting: false, userPending: pending(id), eligible: true, visible: shown([id]) });
  }
  return units;
}
