import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fixture, loadModule, source } from './picker-fixture.mjs';
test('client registers the installed identity and no extra settings page or card', () => {
  const f = fixture();
  try { assert.equal(f.added, 1); assert.deepEqual(Array.from(f.module.inject), ['remote', 'remote.llm', 'connection']); assert.doesNotMatch(source, /settings\.section|WritePanel|ManualEditor|RouteCard|createElement\('(?:article|section|p)'\)|\bfetch\(/); }
  finally { f.dispose(); }
});
test('unrelated dialogs remain untouched; empty editor already has its refresh action', () => {
  const f = fixture({ open: true, unrelated: true });
  try { assert.equal(f.added, 1); assert.equal(f.buttons[0].parentElement, f.head); } finally { f.dispose(); }
});
test('the same single button moves into the native picker and back to its source', async () => {
  const f = fixture();
  try {
    const button = f.buttons[0]; assert.equal(button.parentElement, f.head);
    await f.open([{ id: 'old' }]); await f.flush();
    assert.equal(f.added, 1); assert.equal(button.textContent, '刷新');
    assert.equal(button.className, 'native-button'); assert.equal(f.calls, 0); assert.equal(button.parentElement, f.toolbar);
    assert.equal(button.style.whiteSpace, 'nowrap'); assert.equal(button.style.flexShrink, '0');
    assert.equal(f.selectAllButton.style.whiteSpace, 'nowrap'); assert.equal(f.selectAllButton.style.flexShrink, '0');
    assert.equal(f.search.style.minWidth, '0');
    await f.close(); assert.equal(button.parentElement, f.head); assert.equal(f.added, 1);
  } finally { f.dispose(); }
});
test('picker refresh supports all 0.2.2-rc.3 locales as well as legacy 0.2.1 titles', async () => {
  for (const [sourceLabel, title, selectAllLabel, deselectAllLabel, expectHidden] of [
    ['获取可用模型', '选择模型', '全选', '取消全选', true],
    ['Fetch available models', 'Choose models', 'Select all', 'Deselect all', true],
    ['利用可能なモデルを取得', 'モデルを選択', 'すべて選択', 'すべて解除', true],
    ['获取可用模型', '选择要添加的模型', '全选', '取消全选', false]
  ]) {
    const f = fixture({ sourceLabel, title });
    try {
      await f.open([{ id: 'hidden', checked: true }, { id: 'visible', checked: false }]); await f.flush();
      assert.equal(f.buttons[0].parentElement, f.toolbar);
      f.query('visible'); f.setRows([{ id: 'visible', checked: false }]); await f.flush();
      f.clickDialogButton(selectAllLabel); f.setRows([{ id: 'visible', checked: true }]); await f.flush();
      f.clickDialogButton(deselectAllLabel); f.setRows([{ id: 'visible', checked: false }]); await f.flush();
      f.buttons[0].click(); await f.flush();
      await f.finish([{ id: 'hidden', checked: true }, { id: 'visible', checked: true }]);
      assert.equal(f.row('visible').checked, false);
      assert.equal(f.row('hidden').checked, expectHidden);
    } finally { f.dispose(); }
  }
});
test('outside refresh updates catalog quietly without opening the model picker modal', async () => {
  let quietCalls = 0;
  const f = fixture({ refreshQuiet: async () => { quietCalls++; return { ok: true, value: [{ id: 'new' }] }; } });
  try {
    f.buttons[0].click(); await f.flush();
    assert.equal(quietCalls, 1); assert.equal(f.calls, 0);
    assert.equal(f.buttons[0].parentElement, f.head);
    assert.equal(f.buttons[0].disabled, false);
    assert.equal(f.buttons[0].textContent, '已刷新 (1)');
  } finally { f.dispose(); }
});
test('outside refresh exposes clear failure reason on button without opening modal', async () => {
  const f = fixture({ refreshQuiet: async () => ({ ok: false, error: { code: 'MISSING_CREDENTIAL', message: '未找到可用凭据' } }) });
  try {
    f.buttons[0].click(); await f.flush();
    assert.equal(f.calls, 0);
    assert.equal(f.buttons[0].textContent, '失败：未配置密钥');
    assert.equal(f.buttons[0].title, '未找到可用凭据');
  } finally { f.dispose(); }
});
test('outside refresh extracts provider and apiKey from AddCatalogProviderForm panel', async () => {
  const rpcCalls = [];
  const f = fixture();
  f.dispose();
  const win = f.doc.defaultView;
  const providerSelect = { value: 'google', options: [{ value: 'google' }], getAttribute: name => name === 'aria-label' ? '提供商' : null };
  const retrySelect = { value: 'default', options: [{ value: 'default' }], getAttribute: () => null };
  const keyInput = { type: 'password', value: 'draft-key-fixture', getAttribute: name => name === 'aria-label' ? 'API 密钥' : null };
  const panel = {
    className: 'addPanel', id: 'add-catalog-panel', parentElement: f.doc.body,
    querySelector: () => null,
    querySelectorAll: selector => selector === 'select' ? [providerSelect, retrySelect] : selector === 'input' ? [keyInput] : []
  };
  f.head.parentElement = panel;
  f.owner.closest = selector => selector.includes('addPanel') ? panel : null;
  const remote = { llm: { discoverModels: async () => [] } };
  const connection = { rpc: { call: async (ch, method, payload) => { rpcCalls.push({ ch, method, payload }); return { ok: true, value: [{ id: 'g1' }, { id: 'g2' }] }; } } };
  const hook = f.module.hookRefresh(remote, connection);
  const unmount = f.module.mountPickerRefresh(f.doc, hook.run, null, hook.checkStatus, hook.refreshQuiet);
  try {
    const btn = f.buttons.at(-1);
    btn.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].method, 'model-probe/refreshDiscovery');
    assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[0].payload)), { provider: 'google', apiKey: 'draft-key-fixture' });
    assert.equal(btn.textContent, '已刷新 (2)');
  } finally { unmount(); hook.dispose(); }
});
test('dispose releases observations, listeners and only its own button', async () => {
  const f = fixture(); await f.open([{ id: 'old' }]);
  f.dispose(); await f.flush();
  assert.equal(f.observerOff, true); assert.equal(f.listenerCount, 0);
  assert.equal(f.buttons[0].isConnected, false); assert.equal(f.owner.isConnected, true);
});
test('picker button prompts user when quiet check finds new models and resets after refresh', async () => {
  let status = { status: 'done', newCount: 2 };
  const f = fixture({ checkStatus: async () => status });
  try {
    await f.open([{ id: 'old' }]); await f.flush();
    assert.equal(f.buttons[0].textContent, '发现 2 个新模型 · 刷新');
    status = { status: 'idle', newCount: 0 };
    f.buttons[0].click(); await f.flush();
    await f.finish([{ id: 'old' }, { id: 'new-1' }, { id: 'new-2' }]);
    assert.equal(f.buttons[0].textContent, '刷新');
  } finally { f.dispose(); }
});
function extractClass(source, pattern) {
  const match = pattern.exec(source);
  assert.ok(match, 'Class declaration not found');
  const start = match.index, openBrace = source.indexOf('{', start);
  assert.ok(openBrace > start);
  const templateDepths = [];
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote === '`' && ch === '$' && next === '{') { templateDepths.push(depth); depth++; quote = null; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (templateDepths.length && depth === templateDepths.at(-1)) { templateDepths.pop(); quote = '`'; continue; }
      if (depth === 0) return source.slice(start, source[i + 1] === ';' ? i + 2 : i + 1);
    }
  }
  throw new Error('Unbalanced class braces');
}

const runtime = process.env.DSH_MODEL_TEST_RUNTIME;
test('real Cordis namespace getter keeps caller context, scoped click routing and lifecycle', { skip: !runtime && 'Set DSH_MODEL_TEST_RUNTIME to exercise installed Cordis' }, async () => {
  const { Context, Service } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
  // DSH 0.2.1+ renamed the browser client bundle to client.browser.js; accept either layout.
  const gatewayDir = path.join(runtime, 'node_modules/@deepseek-ai/dsh-api-gateway/lib');
  const gatewayFile = existsSync(path.join(gatewayDir, 'client.js')) ? path.join(gatewayDir, 'client.js') : path.join(gatewayDir, 'client.browser.js');
  const gateway = await readFile(gatewayFile, 'utf8');
  const namespaceSource = extractClass(gateway, /var RemoteNamespaceService\s*=\s*class\b/);
  const Namespace = vm.runInNewContext(namespaceSource + '\nRemoteNamespaceService;', { _deepseek_ai_cordis: { Service }, remoteServiceKey: name => 'remote.' + name, REMOTE_NAMESPACE_FIELDS: new Set() });
  const ctx = new Context(), caller = ctx.extend({ caller: 'native-picker' });
  const local = [], live = [], token = {};
  const ns = new Namespace(ctx, 'llm', (direct, scoped, callerCtx, args) => { local.push({ direct, scoped, callerCtx, args }); return Promise.resolve({ ok: true, value: [] }); });
  ns.installDirect({ method: 'discoverModels' }, token);
  const remote = { get llm() { return caller.get('remote.llm'); } };
  const original = Object.getOwnPropertyDescriptor(ns, 'discoverModels');
  const connection = { rpc: { call(...args) { live.push(args); return Promise.resolve({ ok: true, value: [{ id: 'live' }] }); } } };
  const { module } = loadModule();
  const hook = module.hookRefresh(remote, connection);
  await remote.llm.discoverModels('llm-pi-ai', { provider: 'mount-effect' });
  assert.equal(local.length, 1); assert.equal(local[0].callerCtx.caller, 'native-picker'); assert.equal(live.length, 0);
  const request = { provider: 'openai', baseURL: 'https://fixture.invalid', apiKey: 'fixture-only' };
  await hook.run({ click() { remote.llm.discoverModels('llm-pi-ai', request); remote.llm.discoverModels('other', request); queueMicrotask(() => remote.llm.discoverModels('llm-pi-ai', {})); } });
  assert.equal(live.length, 1); assert.equal(live[0][0], '/api'); assert.equal(live[0][1], 'model-probe/refreshDiscovery'); assert.equal(live[0][2], request);
  assert.equal(local.length, 3); assert.equal(local.at(-1).callerCtx.caller, 'native-picker');
  assert.throws(() => hook.run({ click() { throw Error('click failed'); } }), /click failed/);
  await remote.llm.discoverModels('llm-pi-ai', {}); assert.equal(live.length, 1);
  const retained = remote.llm.discoverModels;
  hook.dispose(); assert.equal(live[0][3].aborted, true);
  assert.equal(Object.getOwnPropertyDescriptor(ns, 'discoverModels').get, original.get);
  await retained('llm-pi-ai', {}); assert.equal(live.length, 1);
  // Reinstall/HMR: old cleanup must not overwrite a newer gateway definition.
  const second = module.hookRefresh(remote, connection);
  ns.remove('direct', 'discoverModels', token);
  ns.installDirect({ method: 'discoverModels' }, {});
  const replacement = Object.getOwnPropertyDescriptor(ns, 'discoverModels');
  second.dispose(); assert.equal(Object.getOwnPropertyDescriptor(ns, 'discoverModels').get, replacement.get);
  const third = module.hookRefresh(remote, connection); third.dispose();
  assert.equal(Object.getOwnPropertyDescriptor(ns, 'discoverModels').get, replacement.get);
  // Real dependent Fibers: do not mount before remote.llm, and unwind/rebind
  // when a namespace provider is unloaded/replaced (not just a fake descriptor).
  const app = new Context(), dom = fixture(); dom.dispose();
  class Remote extends Service { constructor(c) { super(c, 'remote'); } get llm() { return this.ctx.get('remote.llm'); } }
  const services = app.plugin({ apply(c) { new Remote(c); c.provide('connection', connection); } }); await services.await();
  const client = loadModule({ document: dom.doc }).module;
  const fiber = app.plugin(client); await fiber.await();
  assert.notEqual(fiber.state, 2); assert.equal(dom.buttons.at(-1).isConnected, false);
  let current, before;
  const provideNamespace = async () => {
    const provider = app.plugin({ apply(c) {
      current = new Namespace(c, 'llm', () => Promise.resolve({ ok: true, value: [] }));
      current.installDirect({ method: 'discoverModels' }, {});
      before = Object.getOwnPropertyDescriptor(current, 'discoverModels');
    } });
    await provider.await(); await fiber.await(); return provider;
  };
  const provider = await provideNamespace();
  assert.equal(fiber.state, 2); assert.notEqual(Object.getOwnPropertyDescriptor(current, 'discoverModels').get, before.get);
  dom.owner.click = () => app.remote.llm.discoverModels('llm-pi-ai', request);
  dom.buttons.at(-1).click(); assert.equal(live.length, 2);
  await provider.dispose(); await fiber.await();
  assert.notEqual(fiber.state, 2); assert.equal(live.at(-1)[3].aborted, true);
  assert.equal(Object.getOwnPropertyDescriptor(current, 'discoverModels').get, before.get);
  assert.equal(dom.buttons.at(-1).isConnected, false);
  const replacementProvider = await provideNamespace(); assert.equal(fiber.state, 2);
  dom.buttons.at(-1).click(); assert.equal(live.length, 3);
  await fiber.dispose(); assert.equal(Object.getOwnPropertyDescriptor(current, 'discoverModels').get, before.get);
  await replacementProvider.dispose(); await services.dispose();
});
