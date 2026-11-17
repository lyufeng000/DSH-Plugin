import { createJournal } from './lib/journal.js';

// Read-only lifecycle bridge. Never changes DS Bot or Session logs.
export function apply(ctx) {
  const journal = createJournal();
  ctx.on('session/event', (session, event) => journal.record(session, event));
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/completion-sound/lifecycle',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        const url = new URL(request.url);
        const raw = url.searchParams.get('since');
        const result = journal.snapshot(raw === null ? undefined : Number(raw), url.searchParams.get('epoch'));
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      },
    }), 'completion-sound: lifecycle metadata');
  });
}
