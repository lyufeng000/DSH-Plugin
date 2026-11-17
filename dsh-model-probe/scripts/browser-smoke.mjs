import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.env.DSH_MODEL_TEST_ROOT, 'Set DSH_MODEL_TEST_ROOT to an isolated temporary directory');
assert.ok(process.env.DSH_MODEL_TEST_RUNTIME, 'Set DSH_MODEL_TEST_RUNTIME to the reviewed runtime or extracted runtime');
const runtime = process.env.DSH_MODEL_TEST_RUNTIME;

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

const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

await fs.mkdir(process.env.DSH_MODEL_TEST_ROOT, { recursive: true });
const out = await fs.mkdtemp(path.join(process.env.DSH_MODEL_TEST_ROOT, 'native-picker-'));

const frontendDist = path.join(runtime, 'node_modules/@deepseek-ai/dsh-web-frontend/dist');
const frontendAssets = path.join(frontendDist, 'assets');
const indexHtml = await fs.readFile(path.join(frontendDist, 'index.html'), 'utf8');
const entryMatch = indexHtml.match(/<script\b[^>]*type="module"[^>]*\bsrc="\.?\/(assets\/[^"]+)"/i);
assert.ok(entryMatch, 'Missing frontend entry script in index.html');
const entrySrc = '/' + entryMatch[1];
const styleHrefs = [...indexHtml.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*\bhref="\.?\/(assets\/[^"]+)"/gi)].map(m => '/' + m[1]);
assert.ok(styleHrefs.length > 0, 'Missing frontend stylesheets in index.html');

const settingsModelsSource = await fs.readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'), 'utf8');
const exportMarker = settingsModelsSource.lastIndexOf('return module.exports');
assert.ok(exportMarker > 0, 'Missing return module.exports in settings-models bundle');
const native = settingsModelsSource.slice(0, exportMarker)
  + 'exports.NativePicker=ModelListEditor;exports.createModelsOperations=createModelsOperations;'
  + settingsModelsSource.slice(exportMarker);

const gatewayDir = path.join(runtime, 'node_modules/@deepseek-ai/dsh-api-gateway/lib');
const gatewayFile = existsSync(path.join(gatewayDir, 'client.browser.js'))
  ? path.join(gatewayDir, 'client.browser.js')
  : path.join(gatewayDir, 'client.js');
const gatewaySource = await fs.readFile(gatewayFile, 'utf8');
const namespaceSource = extractClass(gatewaySource, /var RemoteNamespaceService\s*=\s*class\b/);
const plugin = await fs.readFile(path.join(root, 'lib/client.js'), 'utf8');

// Real installed list logic, Modal, Button, AnimatedRows, store and CSS primitives;
// vendor responses remain synthetic in-page fixtures (no live account traffic).
const fixture = `window.phase=0;window.calls=0;window.localCalls=0;window.writes=0;window.emptyRoute=false;
const React=window.__staticModules.react;
const {createRoot}=window.__staticModules['react-dom/client'];
const cordis=window.__staticModules['@deepseek-ai/cordis'];
const words={
  models:'模型目录',modelsEmpty:'模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。',addModel:'添加模型',
  fetchModels:'获取可用模型',fetching:'正在询问提供商…',fetchNeedsBaseUrl:'请先填写 API 地址，再获取。',
  fetchEmpty:'该提供商没有列出任何模型，请手动添加。',fetchTitle:'选择模型',
  fetchDescription:'以下是模型提供商的可用模型，勾选的模型即为模型列表。',
  fetchSearch:'搜索模型',fetchNoMatches:'没有匹配的模型。',
  fetchSelectAll:'全选',fetchDeselectAll:'取消全选',fetchAdopt:'更新列表',fetchKeepOne:'请至少保留一个勾选的模型。',
  cancel:'取消',close:'关闭'
};
const _deepseek_ai_cordis=cordis,remoteServiceKey=name=>'remote.'+name,REMOTE_NAMESPACE_FIELDS=new Set();
${namespaceSource}
const cordisCtx=new cordis.Context();const pickerCtx=cordisCtx.extend({caller:'native-picker'});
const ns=new RemoteNamespaceService(cordisCtx,'llm',async(d,s,ctx,args)=>{
  localCalls++;
  if(ctx.caller!=='native-picker')throw Error('lost caller context');
  return {ok:true,value:emptyRoute?[]:[{id:'gpt-6-sol'},{id:'gpt-6-luna'}]};
});
ns.installDirect({method:'discoverModels'},{});
window.remote={get llm(){return pickerCtx.get('remote.llm');}};
const connection={rpc:{async call(route,method,request,signal){
  if(route!=='/api'||method!=='model-probe/refreshDiscovery'||request.provider!=='openai-codex'||!signal)throw Error('bad wire contract');
  calls++;
  return await new Promise((resolve,reject)=>{
    window.completeRefresh=()=>{
      if(phase===3){reject(Error('offline'));return;}
      resolve(phase===2?{ok:false,error:{message:'测试：厂商未返回有效 JSON。'}}:{ok:true,value:[{id:'gpt-6-sol'},{id:'gpt-6-luna'},...(phase===1?[{id:'gpt-6.1-sol'}]:[])]});
    };
  });
}}};
const mount=()=>modules['dsh-live-model-probe'].apply({remote,get:name=>name==='connection'?connection:undefined,effect(fn){fn();}});
mount();window.remountPlugin=mount;
const {NativePicker,createModelsOperations}=modules['@deepseek-ai/dsh-client-ui-settings-models'];
const operations=createModelsOperations({remote});
const nativeRoot=createRoot(document.querySelector('#smoke-root'));let editorKey=0;
window.renderEditor=()=>nativeRoot.render(React.createElement(NativePicker,{key:++editorKey,models:[],onChange(){writes++;},probe:{settingsNs:'llm-pi-ai',provider:'openai-codex'},catalogProvider:'openai-codex',operations,t:k=>words[k]??k,disabled:false,onBusyChange(){}}));
renderEditor();`;

const esc = s => s.replaceAll('</script', '<\\/script');
const smokeBootstrap = `window.modules={};window.__ModuleLoader__={
  create({staticModules}){
    window.__staticModules=staticModules;
    queueMicrotask(()=>document.querySelector('#root')?.remove());
    return {manifest:{plugins:[{id:'hold',immediately:true}]},prefetch:()=>new Promise(()=>{})};
  },
  load(entry){
    window.modules[entry.id]=entry.factory(name=>{
      if(!(name in window.__staticModules))throw Error('Missing static module: '+name);
      return window.__staticModules[name];
    });
  }
};
window.__smokeSources=[['settings-models.js',${JSON.stringify(native)}],['dsh-live-model-probe.js',${JSON.stringify(plugin)}],['smoke-fixture.js',${JSON.stringify(fixture)}]];
window.bootSmoke=()=>{for(const[name,code]of window.__smokeSources)(0,eval)(code+'\\n//# sourceURL='+name);};`;

const smokeHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
${styleHrefs.map(href => `<link rel="stylesheet" href="${href}">`).join('\n')}
<style>
  body{font:16px system-ui;background:#151515;color:#eee;padding:40px;margin:0}
  #smoke-root{max-width:680px;margin:0 auto}
</style>
<script>${esc(smokeBootstrap)}</script>
<script type="module" src="${entrySrc}"></script>
</head>
<body data-ds-dark-theme>
  <div id="root" hidden></div>
  <div id="smoke-root"></div>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/smoke.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(smokeHtml);
    return;
  }
  if (pathname.startsWith('/assets/')) {
    const rel = decodeURIComponent(pathname.slice('/assets/'.length));
    const abs = path.resolve(frontendAssets, rel);
    if (!abs.startsWith(frontendAssets + path.sep)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    try {
      const data = await fs.readFile(abs);
      const mime = MIME_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime });
      res.end(data);
      return;
    } catch {
      res.writeHead(404); res.end('Not found'); return;
    }
  }
  res.writeHead(404); res.end('Not found');
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const smokeUrl = `http://127.0.0.1:${port}/smoke.html`;

const profile = await fs.mkdtemp(path.join(out, 'chrome-'));
const browser = spawn(
  process.env.DSH_MODEL_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' }
);
let ws, session, id = 0;
const pending = new Map();
const delay = ms => new Promise(r => setTimeout(r, ms));
function call(method, params = {}, sid = session) {
  return new Promise((resolve, reject) => {
    const seq = ++id, timer = setTimeout(() => { pending.delete(seq); reject(Error('CDP timeout ' + method)); }, 15000);
    pending.set(seq, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: seq, method, params, ...sid ? { sessionId: sid } : {} }));
  });
}
const evaluate = async expression => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async expression => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(50);
  }
  throw Error('Condition timed out: ' + expression);
};

try {
  let lines;
  for (let i = 0; i < 100; i++) {
    try { lines = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); break; }
    catch { await delay(50); }
  }
  assert.ok(lines);
  ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(Error(m.error.message)); else p.resolve(m.result); }
  };
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId: session } = await call('Target.attachToTarget', { targetId, flatten: true }, null));
  await call('Page.enable');
  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'ws://*', 'wss://*'] });
  await call('Page.navigate', { url: smokeUrl });
  await waitFor('Boolean(window.__staticModules)');
  await call('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
  await evaluate('bootSmoke()');

  await waitFor("window.localCalls===1 && document.querySelector('[data-model-probe-picker-refresh]')");
  assert.equal(await evaluate('calls'), 0); // Real catalog useEffect must be local.
  await evaluate("window.refreshButton=document.querySelector('[data-model-probe-picker-refresh]');[...document.querySelectorAll('button')].find(b=>b.textContent==='获取可用模型').click()");
  await waitFor("document.querySelector('[role=dialog] li label') && refreshButton.closest('[role=dialog]')");
  assert.equal(await evaluate('calls'), 0);
  assert.equal(await evaluate('localCalls'), 2);

  const inputQuery = async value => {
    await evaluate(`(()=>{const s=document.querySelector('[role=dialog] input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  };
  const checked = id => `[...document.querySelectorAll('[role=dialog] li label')].find(l=>l.textContent===${JSON.stringify(id)})?.querySelector('input').checked`;
  await evaluate("[...document.querySelectorAll('[role=dialog] li label')].find(l=>l.textContent==='gpt-6-sol').querySelector('input').click()");
  await inputQuery('luna');
  await waitFor("document.querySelectorAll('[role=dialog] li label').length===1");
  await evaluate('phase=1;refreshButton.click();refreshButton.click()');
  await waitFor('calls===1');

  // User changes both the current selection and filter during the network wait.
  await evaluate("document.querySelector('[role=dialog] li label input').click()");
  await inputQuery('gpt');
  await waitFor("document.querySelectorAll('[role=dialog] li label').length===2");
  await evaluate('completeRefresh()');
  await waitFor("document.querySelector('[role=dialog]').textContent.includes('gpt-6.1-sol')&&!refreshButton.disabled && document.querySelector('[role=dialog] input[type=search]').value==='gpt'");
  assert.equal(await evaluate(checked('gpt-6-sol')), false);
  assert.equal(await evaluate(checked('gpt-6-luna')), false);

  // Hide a deselected choice through the entire next successful refresh.
  await inputQuery('luna');
  await waitFor("document.querySelectorAll('[role=dialog] li label').length===1");
  await evaluate('refreshButton.click()');
  await waitFor('calls===2');
  await evaluate('completeRefresh()');
  await waitFor("!refreshButton.disabled && document.querySelector('[role=dialog] input[type=search]').value==='luna'");
  await inputQuery('');
  await waitFor("document.querySelectorAll('[role=dialog] li label').length===3");
  assert.equal(await evaluate(checked('gpt-6-sol')), false);
  assert.equal(await evaluate(checked('gpt-6-luna')), false);
  assert.equal(await evaluate(checked('gpt-6.1-sol')), true);

  // In 0.2.2-rc.3, filtered "取消全选" only unchecks visible rows and keeps hidden checked rows intact across refresh.
  await inputQuery('luna');
  await waitFor("document.querySelectorAll('[role=dialog] li label').length===1");
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='全选').click()");
  await waitFor(`${checked('gpt-6-luna')}===true`);
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='取消全选').click()");
  await waitFor(`${checked('gpt-6-luna')}===false`);
  await evaluate('phase=1;refreshButton.click()');
  await waitFor('calls===3');
  await evaluate('completeRefresh()');
  await waitFor("!refreshButton.disabled && document.querySelector('[role=dialog] input[type=search]').value==='luna'");
  await inputQuery('');
  await waitFor("document.querySelectorAll('[role=dialog] li label').length===3");
  assert.equal(await evaluate(checked('gpt-6.1-sol')), true);
  assert.equal(await evaluate(checked('gpt-6-luna')), false);
  assert.equal(await evaluate(checked('gpt-6-sol')), false);

  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await fs.writeFile(path.join(out, 'picker-refresh.png'), Buffer.from(shot.data, 'base64'));

  await inputQuery('luna');
  await evaluate('phase=2;refreshButton.click()');
  await waitFor('calls===4');
  await evaluate('completeRefresh()');
  await waitFor("refreshButton.title.includes('JSON')&&!refreshButton.disabled");
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=search]').value"), 'luna');
  assert.equal(await evaluate(checked('gpt-6-luna')), false);
  await inputQuery('');
  await waitFor("document.querySelectorAll('[role=dialog] li label').length===3");
  assert.equal(await evaluate(checked('gpt-6-sol')), false);

  // Transport rejection must also reach the native error and remain retryable.
  await evaluate('phase=3;refreshButton.click()');
  await waitFor('calls===5');
  await evaluate('completeRefresh()');
  await waitFor("refreshButton.title.includes('连接')&&!refreshButton.disabled");
  assert.equal(await evaluate(checked('gpt-6-sol')), false);

  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='取消').click()");
  await waitFor("!document.querySelector('[role=dialog]') && refreshButton.isConnected && !refreshButton.closest('[role=dialog]')");
  assert.equal(await evaluate("document.querySelectorAll('[data-model-probe-picker-refresh]').length"), 1);

  // New/empty route has no picker at all until its explicit refresh succeeds.
  await evaluate('emptyRoute=true;renderEditor()');
  await waitFor('localCalls===3');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='获取可用模型').click()");
  await waitFor("localCalls===4 && document.querySelector('section').textContent.includes('没有列出任何模型')");
  assert.equal(await evaluate("Boolean(document.querySelector('[role=dialog]'))"), false);
  assert.equal(await evaluate('calls'), 5);
  await evaluate("phase=1;window.refreshButton=document.querySelector('[data-model-probe-picker-refresh]');refreshButton.click()");
  await waitFor('calls===6');
  await evaluate('completeRefresh()');
  await waitFor("document.querySelector('[role=dialog] li label') && refreshButton.closest('[role=dialog]') && !refreshButton.disabled");
  assert.equal(await evaluate("document.querySelectorAll('[data-model-probe-picker-refresh]').length"), 1);
  assert.equal(await evaluate('writes'), 0);
  assert.equal(await evaluate('localCalls'), 4);

  // Plugin effect replacement restores then rewraps the real namespace getter.
  await evaluate('remountPlugin()');
  await waitFor("document.querySelectorAll('[data-model-probe-picker-refresh]').length===1 && document.querySelector('[role=dialog] [data-model-probe-picker-refresh]')");
  await evaluate("remote.llm.discoverModels('llm-pi-ai',{provider:'openai-codex'})");
  assert.equal(await evaluate('calls'), 6);

  console.log(JSON.stringify({
    nativeComponent: true,
    nativeModal: true,
    realStaticModules: true,
    realCordisNamespace: true,
    nativeOperations: true,
    mountEffectAndNativeFetchLocal: true,
    oneMovableButton: true,
    emptyRouteRefresh: true,
    newModelVisible: true,
    picksAndInFlightEditsPreserved: true,
    hiddenPicksPreserved: true,
    filteredDeselectAllPreservesHidden: true,
    failedRefreshVisible: true,
    transportFailureVisible: true,
    noConfigWrite: true,
    vendorFixtureCalls: await evaluate('calls'),
    screenshot: path.join(out, 'picker-refresh.png')
  }));
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await call('Browser.close', {}, null).catch(() => {});
    ws.close();
  }
  if (browser.exitCode === null) browser.kill();
  for (const p of pending.values()) clearTimeout(p.timer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
