import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeEngine } from '../lib/engine.js';
import { enrichModels } from '../lib/enrich.js';
import { completeNativeModels } from '../lib/native-save.js';

const raw = { id: 'known', provider: 'test', api: 'openai-responses', baseUrl: 'https://configured.test/v1', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' } };
function fixture() {
  const current = { providers: { test: { models: [{ id: 'known', name: 'My name', contextWindow: 12345 }, { id: 'custom', contextWindow: 32768 }] } } };
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: current } };
  const accesses = [];
  const forbidden = key => () => { accesses.push(key); throw Error(`Forbidden ${key}`); };
  const catalog = { list: route => route === 'test' ? [raw] : [], lookup: (route, id) => route === 'test' && id === 'known' ? raw : undefined, defaults: route => route === 'test' ? { api: raw.api, baseURL: raw.baseUrl } : {} };
  const ctx = { configEditor: { entries: () => [entry], configuration: () => [{ entry, inherited: {} }], edit: forbidden('edit') }, credentials: { resolve: forbidden('resolve'), readRecord: forbidden('credential record') }, llm: { listModels: forbidden('runtime list') } };
  const engine = new ProbeEngine(ctx, {}, { catalog, transport: { fetch: forbidden('network') }, catalogCache: { read: forbidden('cache read'), write: forbidden('cache write') } });
  return { engine, current, accesses, catalog };
}

test('ordinary discovery reads latest static configuration only, without credentials, network, cache, writes or adapter fallback', async () => {
  const f = fixture();
  let models = await f.engine.discoverForSettings({ provider: 'test' });
  assert.deepEqual(models.map(x => x.id), ['known', 'custom']);
  assert.deepEqual(models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
  assert.equal(models[0].name, 'My name'); assert.equal(models[0].contextWindow, 12345);
  assert.equal(models[1].contextWindow, 32768); assert.equal(models[1].reasoningEfforts, undefined);
  f.current.providers.test.models.push({ id: 'saved-now', reasoningEfforts: false });
  models = await f.engine.discoverForSettings({ provider: 'test' });
  assert.equal(models.at(-1).id, 'saved-now'); assert.equal(models.at(-1).reasoningEfforts, false);
  assert.deepEqual(f.accesses, []); f.engine.dispose();
});

test('draft identities and new routes never consult credentials or leak another route static selection', async () => {
  const f = fixture();
  for (const request of [
    { provider: 'test', apiKey: '' },
    { provider: 'test', baseURL: 'https://other.test/v1' }, { provider: 'test', api: 'anthropic-messages' },
    { provider: 'unknown' }, { provider: 'constructor' }, { provider: '__proto__' }
  ]) assert.deepEqual(await f.engine.discoverForSettings(request), []);
  assert.deepEqual(f.accesses, []);
  assert.deepEqual(await f.engine.discoverForSettings({ provider: 'test', apiKey: 'draft-fixture' }), []);
  assert.deepEqual(f.accesses, ['network']);
  f.engine.dispose();
});

test('saved endpoint or protocol overrides cannot inherit a builtin reasoning declaration', async () => {
  for (const override of [{ api: 'openai-completions' }, { baseURL: 'https://other.test/v1' }]) {
    const f = fixture(); Object.assign(f.current.providers.test, override);
    const models = await f.engine.discoverForSettings({ provider: 'test' });
    assert.equal(models[0].reasoningEfforts, undefined);
    assert.deepEqual(f.accesses, []); f.engine.dispose();
  }
});

test('explicit static capability and builtin modelOverrides take precedence; cancelling is immediate', async () => {
  const f = fixture();
  f.current.providers.test.models[0].reasoningEfforts = false;
  assert.equal((await f.engine.discoverForSettings({ provider: 'test' }))[0].reasoningEfforts, false);
  delete f.current.providers.test.models;
  f.current.providers.test.modelOverrides = { known: { reasoningEfforts: { high: 'high' } } };
  assert.deepEqual((await f.engine.discoverForSettings({ provider: 'test' }))[0].reasoningEfforts, { high: 'high' });
  await assert.rejects(f.engine.discoverForSettings({ provider: 'test' }, AbortSignal.abort()), { code: 'CANCELLED' });
  assert.deepEqual(f.accesses, []); f.engine.dispose();
  await assert.rejects(f.engine.discoverForSettings({ provider: 'test' }), { code: 'UNAVAILABLE' });
});

test('native static save is possible without any live discovery, and preserves selected rows and capacities', async () => {
  const f = fixture();
  const next = structuredClone(f.current);
  const catalogs = [{ route: 'test', config: structuredClone(f.current.providers.test), models: f.engine.localModels('test', f.current.providers.test) }];
  const completed = completeNativeModels(next, f.current, catalogs);
  assert.deepEqual(completed.providers.test.models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
  assert.deepEqual(completed.providers.test.models.map(x => [x.id, x.contextWindow]), [['known', 12345], ['custom', 32768]]);
  assert.equal(next.providers.test.models[0].reasoningEfforts, undefined);
  assert.deepEqual(f.accesses, []); f.engine.dispose();
});

test('gateway effort metadata never overwrites native Anthropic semantics or invents adaptive support', () => {
  const model = { ...raw, provider: 'openrouter', id: 'anthropic/claude', api: 'anthropic-messages', compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } };
  const catalog = { lookup: (route, id) => id === model.id ? model : undefined };
  const [result] = enrichModels([{ id: model.id, reasoningEfforts: { off: 'none', high: 'high' } }], { route: 'openrouter', catalog, discoveryApi: 'openrouter' });
  assert.deepEqual(result.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  const [unknown] = enrichModels([{ id: 'unknown-anthropic', reasoningEfforts: { high: 'high', max: 'max' } }], { api: 'anthropic-messages', discoveryApi: 'anthropic-messages', catalog });
  assert.equal(unknown.reasoningEfforts, undefined);
});

test('discoverForSettings prefers saved catalog file, quietly checks once for new models, and prompts refresh without retries', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { CatalogCache } = await import('../lib/catalog-cache.js');
  const dir = await mkdtemp(join(tmpdir(), 'model-probe-quiet-'));
  const current = { providers: { test: { api: 'openai-completions', baseURL: 'https://configured.test/v1', apiKeyEnv: 'FIXTURE_KEY', models: [{ id: 'local-only' }] } } };
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: current } };
  let fetchCalls = 0, shouldFail = false;
  const ctx = {
    configEditor: { entries: () => [entry], configuration: () => [{ entry, inherited: {} }] },
    credentials: { resolve: async () => ({ value: 'secret-key' }), readRecord: async () => undefined },
    llm: { listModels: async () => [] }
  };
  const catalogCache = new CatalogCache(dir);
  const transport = {
    fetch: async () => {
      fetchCalls++;
      if (shouldFail) throw new Error('network down');
      return Response.json({ data: [{ id: 'local-only' }, { id: 'fresh-model' }] });
    }
  };
  const catalog = { list: route => route === 'test' ? [{ id: 'local-only' }] : [], defaults: () => ({}), lookup: () => undefined };
  const engine = new ProbeEngine(ctx, { credentialRef: x => x, credentialKey: (a, b) => `${a}/${b}` }, { catalog, transport, catalogCache });
  try {
    // First open: no catalog file yet -> returns local list immediately, quietly fetches in background.
    const initial = await engine.discoverForSettings({ provider: 'test' });
    assert.deepEqual(initial.map(x => x.id), ['local-only']);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fetchCalls, 1);
    assert.deepEqual(await engine.discoveryStatus({ provider: 'test' }), { status: 'done', newCount: 1 });

    // Refresh consumes the quietly fetched list without another fetch call.
    const refreshed = await engine.refreshForSettings({ provider: 'test' });
    assert.deepEqual(refreshed.map(x => x.id), ['local-only', 'fresh-model']);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(await engine.discoveryStatus({ provider: 'test' }), { status: 'idle', newCount: 0 });

    // Second open: reads from saved catalog file first; failed quiet check does not retry or throw.
    shouldFail = true;
    const secondEngine = new ProbeEngine(ctx, { credentialRef: x => x, credentialKey: (a, b) => `${a}/${b}` }, { transport, catalogCache: new CatalogCache(dir) });
    try {
      const fromFile = await secondEngine.discoverForSettings({ provider: 'test' });
      assert.deepEqual(fromFile.map(x => x.id), ['local-only', 'fresh-model']);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(fetchCalls, 2);
      assert.deepEqual(await secondEngine.discoveryStatus({ provider: 'test' }), { status: 'idle', newCount: 0 });
    } finally { secondEngine.dispose(); }
  } finally { engine.dispose(); }
});

test('discoverForSettings fetches full list once for custom route without builtin catalog, saves file, then opens instantly from file', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { CatalogCache } = await import('../lib/catalog-cache.js');
  const dir = await mkdtemp(join(tmpdir(), 'model-probe-empty-'));
  const current = { providers: { custom: { displayName: 'My Custom', api: 'openai-completions', baseURL: 'https://custom.test/v1', apiKeyEnv: 'FIXTURE_KEY', models: [{ id: 'custom-a' }] } } };
  const entry = { options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: current } };
  let fetchCalls = 0, releaseSecond;
  const ctx = {
    configEditor: { entries: () => [entry], configuration: () => [{ entry, inherited: {} }] },
    credentials: { resolve: async () => ({ value: 'secret-key' }), readRecord: async () => undefined },
    llm: { listModels: async () => [] }
  };
  const engine = new ProbeEngine(ctx, { credentialRef: x => x, credentialKey: (a, b) => `${a}/${b}` }, {
    transport: { fetch: async () => {
      fetchCalls++;
      if (fetchCalls === 1) return Response.json({ data: [{ id: 'custom-a' }, { id: 'custom-b' }] });
      return new Promise(resolve => { releaseSecond = () => resolve(Response.json({ data: [{ id: 'custom-a' }, { id: 'custom-b' }, { id: 'custom-c' }] })); });
    } },
    catalogCache: new CatalogCache(dir)
  });
  try {
    assert.equal(engine.discoveryPlan({ displayName: 'My Custom' })?.route, 'custom');
    const models = await engine.discoverForSettings({ provider: 'custom' });
    assert.deepEqual(models.map(x => x.id), ['custom-a', 'custom-b']);
    assert.equal(fetchCalls, 1);

    // Second open returns immediately from saved catalog file while quiet check runs in background.
    const instant = await engine.discoverForSettings({ provider: 'custom' });
    assert.deepEqual(instant.map(x => x.id), ['custom-a', 'custom-b']);
    assert.deepEqual(await engine.discoveryStatus({ provider: 'custom' }), { status: 'checking', newCount: 0 });
    releaseSecond();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await engine.discoveryStatus({ provider: 'custom' }), { status: 'done', newCount: 1 });
  } finally { engine.dispose(); }
});
