import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { runtimeBody, runtimeExports } from '../test/native-runtime.mjs';
import { resolveChrome, selectBuildDirectory } from './check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requestedOut = process.env.DSH_LMM_BUILD_DIR;
if (!requestedOut || !path.isAbsolute(requestedOut)) throw new Error('Set DSH_LMM_BUILD_DIR to an absolute isolated candidate directory');
const out = await selectBuildDirectory({ requested: requestedOut });
const chrome = await resolveChrome();
const bundle = await build({ absWorkingDir: root, entryPoints: ['test/browser-native.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120' });
const client = await fs.readFile(path.join(out, 'client.js'), 'utf8');
const source = runtimeBody() + '\n' + runtimeExports;
const escape = script => script.replaceAll('</script', '<\\/script');
const html = `<!doctype html><html><head><meta charset="UTF-8"><title>Isolated native composer probe</title><style>
body{margin:0;padding:64px;font:16px/1.6 system-ui;color:#263140;background:#f6f7f9}#card{max-width:560px;background:#fff;border:1px solid #8893a5;border-radius:12px;padding:16px}[data-input-scroll]{max-height:220px;overflow-y:auto;overflow-x:hidden}#editor{outline:none;white-space:pre-wrap;overflow-wrap:anywhere;min-height:40px}#editor p{margin:0}#footer{padding-top:12px;color:#667085;font-size:13px}h2{font-size:18px}#outside{height:90px}
</style></head><body><h2>原生输入框 · 隔离验证</h2><div id="card"><div data-input-scroll><div id="editor" contenteditable="true" tabindex="0"></div></div><div id="footer">保留原生输入、图片入口与发送逻辑（本页不连接 DSH）</div></div><div id="outside"></div><script>${escape(bundle.outputFiles[0].text)}</script><script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>{if(name!=='react')throw Error(name);return window.React})}};</script><script>${escape(client)}</script><script>
window.createNativeProbe(new Function('react_jsx_runtime','react',${JSON.stringify(source)}), window.plugin).catch(error => { window.probeError = error.stack || error.message; });
</script></body></html>`;
const pageFile = path.join(out, 'native-probe.html'); await fs.writeFile(pageFile, html);
const profile = await fs.mkdtemp(path.join(out, 'chrome-native-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', '--window-size=960,800', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let launchError = null;
child.on('error', error => { launchError = error; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, session, seq = 0; const pending = new Map(), results = [];
function call(method, params = {}, sid = session) {
  return new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function waitFor(expression, description) {
  await evaluate(`probe.waitFor(() => (${expression}), ${JSON.stringify(description)})`);
}
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, passed: true, detail }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
try {
  let lines;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw new Error(`Cannot launch isolated Chrome: ${launchError.message}`);
    if (child.exitCode !== null) throw new Error(`Isolated Chrome exited before startup (${child.exitCode})`);
    try { lines = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); break; }
    catch { await delay(50); }
  }
  if (!lines) throw new Error('Isolated Chrome did not expose its own debug endpoint');
  socket = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data); const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error.message)); else item.resolve(data.result);
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId: session } = await call('Target.attachToTarget', { targetId, flatten: true }, null));
  await call('Page.enable'); await call('Runtime.enable'); await call('Page.navigate', { url: pathToFileURL(pageFile).href });
  for (let i = 0; i < 100 && !await evaluate('!!window.probe || !!window.probeError'); i++) await delay(50);
  assert.equal(await evaluate('window.probeError || null'), null, 'Candidate lifecycle must mount without errors');
  assert.equal(await evaluate('!!window.probe'), true, 'Isolated native probe did not become ready');
  await evaluate('document.fonts.ready.then(()=>probe.wait())');

  await check('candidate bundle mounts its native lifecycle on the resident editor', async () => {
    await waitFor('probe.root.dataset.lmmNative === plugin.revision && document.querySelectorAll(".lmm-native-layer").length === 1', 'the candidate native lifecycle');
    const state = await evaluate(`({revision: probe.root.dataset.lmmNative, expected: plugin.revision, layers: document.querySelectorAll('.lmm-native-layer').length})`);
    assert.equal(state.revision, state.expected); assert.equal(state.layers, 1);
    return state;
  });

  await check('Chinese IME keeps exact source and caret through commits and middle edits', async () => {
    const cases = [];
    for (const [before, at, commit, next] of [
      ['', 0, '技术方向换成官方论坛', '，继续'],
      ['# 技术方向', 6, '换成官方论坛', '，继续'],
      ['- 技术方向', 6, '换成官方论坛', '，继续'],
      ['**技术方向**', 8, '换成官方论坛', '，继续'],
      ['技术方向换成官方论坛', 4, '调整为', '新'],
      ['前一段\n技术方向换成官方论坛', 8, '调整为', '新'],
    ]) {
      await evaluate(`probe.set(${JSON.stringify(before)}${before ? `, ${at}` : ''})`);
      for (const text of [commit.slice(0, 1), commit]) {
        await call('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await delay(40);
      }
      await call('Input.insertText', { text: commit }); await delay(180);
      const expected = before.slice(0, at) + commit + before.slice(at), caret = at + commit.length;
      const settled = await evaluate('({ ...probe.project(), dom: probe.domRange(), errors: probe.errors })');
      assert.equal(settled.text, expected, 'Chinese commit preserves the surrounding text');
      assert.equal(settled.range.anchor, caret); assert.equal(settled.range.focus, caret);
      assert.deepEqual(settled.dom, { anchor: caret, focus: caret });
      await call('Input.insertText', { text: next }); await delay(140);
      const typed = await evaluate('({ ...probe.project(), dom: probe.domRange(), errors: probe.errors })');
      assert.equal(typed.text, expected.slice(0, caret) + next + expected.slice(caret));
      assert.equal(typed.range.anchor, caret + next.length); assert.equal(typed.range.focus, caret + next.length);
      assert.deepEqual(typed.dom, { anchor: caret + next.length, focus: caret + next.length });
      assert.deepEqual(typed.errors, []);
      cases.push({ before, commit, text: typed.text, caret: typed.dom.anchor });
    }
    return { cases };
  });
  await check('themed Markdown editors retain a visible browser caret without a stale overlay', async () => {
    await evaluate(`probe.set('**技术方向** 换成官方论坛')`);
    // Reproduce the installed theme's public DOM/CSS contract, including a host
    // that is already positioned and therefore has no caret-host attribute.
    await evaluate(`(() => {
      const style = document.createElement('style'); style.id = 'theme-caret-contract';
      style.textContent = 'body[data-dsh-claude-style] [data-composer-input][data-dsh-claude-caret],body[data-dsh-claude-style] input[data-dsh-claude-caret]{caret-color:transparent}body[data-dsh-claude-style] [data-dsh-claude-caret-layer][data-dsh-claude-caret-layer]{position:absolute;visibility:hidden;pointer-events:none}body[data-dsh-claude-style] [data-dsh-claude-caret-layer][data-dsh-claude-caret-layer][data-dsh-claude-caret-visible]{visibility:visible}';
      document.head.append(style); document.body.setAttribute('data-dsh-claude-style', '');
      probe.root.setAttribute('data-composer-input', ''); probe.root.setAttribute('data-dsh-claude-caret', '');
      const cursor = () => { const e = document.createElement('div'); e.setAttribute('data-dsh-claude-caret-layer', ''); e.setAttribute('data-dsh-claude-caret-visible', ''); return e; };
      window.themeCaret = cursor(); probe.root.parentElement.append(themeCaret);
      window.themeOutsideHost = document.createElement('div'); const input = document.createElement('input');
      input.setAttribute('data-dsh-claude-caret', ''); themeOutsideHost.append(input, cursor()); document.body.append(themeOutsideHost);
    })()`);
    try {
      const state = await evaluate(`({ native: getComputedStyle(probe.root).caretColor, overlay: getComputedStyle(themeCaret).visibility, outside: getComputedStyle(themeOutsideHost.firstChild).caretColor, outsideOverlay: getComputedStyle(themeOutsideHost.lastChild).visibility, focused: document.activeElement === probe.root })`);
      assert.equal(state.focused, true);
      assert.notEqual(state.native, 'rgba(0, 0, 0, 0)', 'the browser must paint the caret in the owned editor');
      assert.equal(state.overlay, 'hidden', 'the theme must not paint a second caret from stale geometry');
      assert.equal(state.outside, 'rgba(0, 0, 0, 0)', 'the theme retains other fields');
      assert.equal(state.outsideOverlay, 'visible');
      await evaluate('probe.root.blur()');
      assert.equal(await evaluate('getComputedStyle(themeCaret).visibility'), 'hidden', 'a pending theme resync must not expose a stale caret on blur');
      await evaluate('themeOutsideHost.firstChild.focus()');
      assert.equal(await evaluate('getComputedStyle(themeOutsideHost.lastChild).visibility'), 'visible');
      return state;
    } finally {
      await evaluate(`themeCaret.remove(); themeOutsideHost.remove(); document.querySelector('#theme-caret-contract').remove(); document.body.removeAttribute('data-dsh-claude-style'); probe.root.removeAttribute('data-composer-input'); probe.root.removeAttribute('data-dsh-claude-caret'); delete window.themeCaret; delete window.themeOutsideHost; probe.root.focus()`);
    }
  });

  await check('native browser typing formats Markdown without a toggle or source loss', async () => {
    await evaluate('probe.set("")');
    const text = '# 标题 **粗体** `code` 😀';
    await call('Input.insertText', { text }); await delay(160);
    await waitFor('probe.root.querySelectorAll("[data-lmm-hide]").length >= 3', 'typed Markdown markers');
    const state = await evaluate('probe.snapshot()'); assert.equal(state.text, text);
    assert.ok(state.markers.length >= 3); assert.equal(state.failed, false); assert.deepEqual(state.errors, []);
    return { hiddenMarkers: state.markers.length, text: state.text };
  });
  for (const prefix of ['1. ', '12) ', '- ', '* ', '+ ', '# ', '## ', '> ', '**bold** ', '_word_ ', '~~word~~ ', '`code` ']) {
    await check(`incremental typing keeps the model and browser caret after ${JSON.stringify(prefix)}`, async () => {
      const cases = [];
      for (const context of ['', 'before\n']) {
        await evaluate(`probe.set(${JSON.stringify(context)})`);
        let expected = context;
        for (const char of `${prefix}next`) {
          if (char === ' ') {
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
            await call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
          } else await call('Input.insertText', { text: char });
          expected += char;
          await delay(140);
          const state = await evaluate('({ ...probe.project(), dom: probe.domRange(), errors: probe.errors })');
          assert.equal(state.text, expected, `source after ${JSON.stringify(char)}`);
          assert.deepEqual(state.range, { from: expected.length, to: expected.length, anchor: expected.length, focus: expected.length }, 'model caret follows the inserted character');
          assert.deepEqual(state.dom, { anchor: expected.length, focus: expected.length }, 'browser caret agrees with the model');
          assert.deepEqual(state.errors, []);
        }
        cases.push(expected);
      }
      return { cases };
    });
  }
  for (const prefix of ['1. ', '12) ', '- ', '* ', '+ ', '# ', '## ', '> ', '**bold** ', '_word_ ', '~~word~~ ', '`code` ']) {
    await check(`IME settlement preserves the model and browser caret after ${JSON.stringify(prefix)}`, async () => {
      const cases = [];
      for (const [before, commit] of [['', prefix], [prefix.slice(0, -1), ' '], [`before\n${prefix.slice(0, -1)}`, ' ']]) {
        await evaluate(`probe.set(${JSON.stringify(before)})`);
        await call('Input.imeSetComposition', { text: commit, selectionStart: commit.length, selectionEnd: commit.length });
        await call('Input.insertText', { text: commit });
        await delay(180);
        const expected = `${before}${commit}`, settled = await evaluate('({ ...probe.project(), dom: probe.domRange(), errors: probe.errors })');
        assert.equal(settled.text, expected, 'IME commits the exact source');
        assert.deepEqual(settled.range, { from: expected.length, to: expected.length, anchor: expected.length, focus: expected.length }, 'model caret follows the IME commit');
        assert.deepEqual(settled.dom, { anchor: expected.length, focus: expected.length }, 'browser caret survives delayed Markdown transforms');
        await call('Input.insertText', { text: 'next' });
        await delay(140);
        const typed = await evaluate('({ ...probe.project(), dom: probe.domRange(), errors: probe.errors })');
        assert.equal(typed.text, `${expected}next`, 'typing resumes at the committed caret');
        assert.deepEqual(typed.range, { from: expected.length + 4, to: expected.length + 4, anchor: expected.length + 4, focus: expected.length + 4 });
        assert.deepEqual(typed.dom, { anchor: expected.length + 4, focus: expected.length + 4 });
        assert.deepEqual(typed.errors, []);
        cases.push({ before, commit, settled: settled.range, text: typed.text });
      }
      return { cases };
    });
  }
  await check('IME settlement leaves a newly focused control and its selection alone', async () => {
    await evaluate(`probe.set(""); window.imeOutside = document.createElement('input'); imeOutside.value = 'outside'; document.body.append(imeOutside); probe.root.addEventListener('compositionend', () => { imeOutside.focus(); imeOutside.setSelectionRange(1, 4); }, { once: true });`);
    try {
      await call('Input.imeSetComposition', { text: '1. ', selectionStart: 3, selectionEnd: 3 });
      await call('Input.insertText', { text: '1. ' });
      await delay(180);
      const state = await evaluate('({ text: probe.project().text, externalFocus: document.activeElement === imeOutside, start: imeOutside.selectionStart, end: imeOutside.selectionEnd, errors: probe.errors })');
      assert.equal(state.text, '1. ');
      assert.equal(state.externalFocus, true);
      assert.equal(state.start, 1); assert.equal(state.end, 4);
      assert.deepEqual(state.errors, []);
      return state;
    } finally { await evaluate('imeOutside.remove(); delete window.imeOutside'); }
  });
  await check('Enter continues a list, and an empty item ends it', async () => {
    const pressEnter = async () => {
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    };
    await evaluate(`probe.set(${JSON.stringify('1. 内容')}, 5)`);
    await pressEnter(); await delay(140);
    await waitFor('probe.project().text === "1. 内容\\n2. " && [...probe.root.querySelectorAll("[data-lmm-hide]")].some(element => element.textContent === "2.")', 'the continued ordered-list label');
    const continued = await evaluate('probe.snapshot()');
    assert.equal(continued.text, '1. 内容\n2. ', 'the new line continues the numbering');
    assert.ok(continued.markers.some(marker => marker.source === '2.'), 'the inherited marker renders as a list label');
    await pressEnter(); await delay(140);
    const ended = await evaluate('probe.snapshot()');
    assert.equal(ended.text, '1. 内容\n', 'Enter on the empty item drops its marker');
    assert.deepEqual(ended.errors, []);
    return {continued: continued.text, ended: ended.text};
  });
  await check('bare ordered marker previews after a paragraph without a doubled label at the caret', async () => {
    const source = '给网页做一个功能：\n1.';
    await evaluate(`probe.set(${JSON.stringify(source)}, ${source.length - 1})`);
    await waitFor(`(() => { const element = probe.root.querySelector('[data-lmm-role~="olm"]'); return element && getComputedStyle(element, '::before').content === 'none'; })()`, 'editable ordered-list source at the caret');
    const active = await evaluate(`(() => { const e=probe.root.querySelector('[data-lmm-role~="olm"]'); return {text:probe.project().text, label: e && getComputedStyle(e,'::before').content}; })()`);
    assert.equal(active.text, source); assert.equal(active.label, 'none');
    await evaluate('document.activeElement.blur();probe.refresh();probe.wait()');
    await waitFor(`(() => { const element = probe.root.querySelector('[data-lmm-role~="olm"]'); return element && getComputedStyle(element, '::before').content.includes('1.'); })()`, 'the ordered-list label after blur');
    const inactive = await evaluate(`(() => { const e=probe.root.querySelector('[data-lmm-role~="olm"]'); return {label:getComputedStyle(e,'::before').content,width:e.getBoundingClientRect().width}; })()`);
    assert.ok(inactive.label.includes('1.')); assert.ok(inactive.width > 0);
    return {active, inactive};
  });
  await check('real Shift+Enter continues an item before later paragraphs', async () => {
    await evaluate(`probe.set(${JSON.stringify('1. 第一项\n后续段落')}, 6)`);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    await delay(140);
    const state = await evaluate('probe.snapshot()');
    assert.equal(state.text, '1. 第一项\n2. \n后续段落');
    assert.deepEqual(state.errors, []);
    return {text:state.text};
  });
  await check('hidden TeX is not spell-checked and the rendered formula is opaque', async () => {
    await evaluate(`probe.set(${JSON.stringify('公式 $\\frac{1}{2}$ 结束')}, 19)`);
    await delay(220);
    const state = await evaluate(`(() => { const p = probe.root.querySelector('[data-lmm-math="true"]'); const o = document.querySelector('.lmm-native-layer .lmm-native-formula'); return {placeholder: !!p, spell: p ? p.getAttribute('spellcheck') : null, overlay: !!o, bg: o ? getComputedStyle(o).backgroundColor : null, errors: probe.errors.length}; })()`);
    assert.equal(state.placeholder, true, `a math placeholder must exist: ${JSON.stringify(state)}`);
    assert.equal(state.spell, 'false', `hidden TeX must not be spell-checked: ${JSON.stringify(state)}`);
    assert.equal(state.overlay, true, `the formula must be rendered: ${JSON.stringify(state)}`);
    assert.notEqual(state.bg, 'rgba(0, 0, 0, 0)', `the rendered formula must be opaque: ${JSON.stringify(state)}`);
    assert.equal(state.errors, 0);
    return state;
  });  await check('standard lists render a view-only label without losing source', async () => {
    await evaluate(`probe.set(${JSON.stringify('- 第一项\n1. 第二项')})`);
    await waitFor(`probe.root.querySelector('[data-lmm-role~="ulm"][data-lmm-hide="true"]') && probe.root.querySelector('[data-lmm-role~="olm"][data-lmm-hide="true"]')`, 'both painted list markers');
    const state = await evaluate(`(() => {
      const root = probe.root;
      const items = [...root.querySelectorAll('[data-lmm-hide]')].map(e => {
        const pseudo = getComputedStyle(e, '::before');
        return { role: e.getAttribute('data-lmm-role'), source: e.textContent, label: pseudo.content, fill: pseudo.webkitTextFillColor, ownFill: getComputedStyle(e).webkitTextFillColor, hidden: getComputedStyle(e).visibility };
      });
      return { items, text: probe.project().text, errors: probe.errors, failed: probe.snapshot().failed };
    })()`);
    assert.equal(state.failed, false); assert.deepEqual(state.errors, []);
    assert.equal(state.text, '- 第一项\n1. 第二项');
    const bullet = state.items.find(item => item.role === 'ulm');
    const ordered = state.items.find(item => item.role === 'olm');
    assert.ok(bullet && ordered, `both list markers are hidden: ${JSON.stringify(state.items)}`);
    assert.ok(bullet.label.includes('\\2022') || bullet.label.includes('•'), `bullet uses a real bullet glyph: ${bullet.label}`);
    assert.ok(ordered.label.includes('1.'), `ordered marker re-renders the source number: ${ordered.label}`);
    for (const item of [bullet, ordered]) {
      assert.equal(item.ownFill, 'rgba(0, 0, 0, 0)', 'hidden source stays transparent');
      assert.notEqual(item.fill, 'rgba(0, 0, 0, 0)', 'generated label must stay visible');
    }
    return state.items;
  });
  await check('composition keeps a rendered line instead of reverting to source', async () => {
    await evaluate(`probe.set(${JSON.stringify('# 标题')}, 3)`);
    await waitFor('probe.root.querySelectorAll("[data-lmm-hide]").length === 1', 'the heading view before composition');
    const before = await evaluate('probe.snapshot()');
    assert.equal(before.markers.length, 1, 'the heading marker starts hidden');
    let during;
    try {
      await evaluate(`probe.root.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}))`);
      await evaluate('probe.wait()');
      during = await evaluate(`(() => { const s = probe.snapshot(); return {markers: s.markers.length, composing: probe.root.hasAttribute('data-lmm-composing'), text: s.text, errors: s.errors}; })()`);
      assert.equal(during.composing, true, 'composition is flagged');
      assert.equal(during.markers, 1, 'composition must not reveal hidden source');
      // The resident editor inserts a zero-width space anchor while composing;
      // the plugin must leave that alone and never touch the rest of the draft.
      assert.equal(during.text.replaceAll('\u200b', ''), '# 标题', `composition must not rewrite the draft: [${[...during.text].map(c => c.codePointAt(0).toString(16)).join(' ')}]`);
    } finally {
      await evaluate(`probe.root.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: ''}))`);
      await delay(140);
    }
    await evaluate(`probe.set(${JSON.stringify('# 标题')}, 3)`);
    await waitFor('probe.root.querySelectorAll("[data-lmm-hide]").length === 1', 'the settled heading view');
    const after = await evaluate('probe.snapshot()');
    assert.equal(after.markers.length, 1, 'the view is still rendered after composition settles');
    assert.deepEqual(after.errors, []);
    return {before: before.markers.length, during: {...during, text: during.text}, after: after.markers.length};
  });
  await check('unconfirmed hash stays visible while typing and never hides mid-word', async () => {
    await evaluate('probe.set("#", 1)');
    const pending = await evaluate('probe.snapshot()'), pendingCaret = await evaluate('probe.caret()');
    assert.equal(pending.markers.length, 0, 'a lone hash must stay plain source before the heading space');
    assert.equal(pending.text, '#');
    assert.ok(pendingCaret.height >= 12, 'caret stays visible while typing a pending hash');
    await call('Input.insertText', { text: 'include' }); await delay(120);
    const word = await evaluate('probe.snapshot()');
    assert.equal(word.text, '#include'); assert.equal(word.markers.length, 0, '#include must never hide the leading hash');
    await evaluate('probe.set("# 标题", 2)');
    await waitFor('probe.root.querySelectorAll("[data-lmm-hide]").length >= 1', 'the confirmed heading marker');
    const heading = await evaluate('probe.snapshot()'), headingCaret = await evaluate('probe.caret()');
    assert.ok(heading.markers.length >= 1, 'a confirmed heading hides its marker');
    assert.ok(headingCaret.height >= 12, `caret at the heading boundary must stay visible: ${JSON.stringify(headingCaret)}`);
    assert.ok(Math.abs(headingCaret.left - heading.markers[0].rect.left) < 2, 'caret sits where the hidden marker is displayed');
    assert.ok(heading.markers[0].rect.width < 1, 'hidden marker must not occupy width');
    return {pendingCaret, word: word.text, headingCaret, marker: heading.markers[0].rect};
  });
  await check('hidden Markdown and TeX still show a native caret where it lives', async () => {
    await evaluate('probe.set("**bold**", 2)');
    await waitFor('probe.root.querySelectorAll("[data-lmm-hide]").length === 2', 'the bold delimiter view');
    const bold = await evaluate('probe.snapshot()'), boldCaret = await evaluate('probe.caret()');
    assert.ok(boldCaret.height >= 12, `caret at a hidden delimiter boundary must stay visible: ${JSON.stringify(boldCaret)}`);
    assert.ok(boldCaret.left >= bold.markers[0].rect.left - 1 && boldCaret.left <= bold.markers[1].rect.left + 1, 'caret stays between the hidden delimiters');
    // Finishing a formula must not move anything: while the caret still sits on the
    // closing delimiter the source keeps its own geometry and no box is drawn.
    await evaluate('probe.set("$x$", 3)');
    const open = await evaluate('probe.snapshot()'), openCaret = await evaluate('probe.caret()');
    assert.equal(open.placeholders.length, 0, 'a formula must not collapse under its own caret');
    assert.ok(openCaret.height >= 12, `caret on the closing delimiter must stay visible: ${JSON.stringify(openCaret)}`);
    assert.deepEqual(open.errors, []);
    // Once the caret has left it, the formula renders.
    await evaluate(`probe.set(${JSON.stringify('公式 $x$ 后')}, 0)`);
    await waitFor('probe.root.querySelectorAll("[data-lmm-math]").length === 1', 'the formula placeholder away from the caret');
    const math = await evaluate('probe.snapshot()'), mathCaret = await evaluate('probe.caret()');
    assert.equal(math.placeholders.length, 1, 'the formula renders once the caret has left it');
    assert.ok(mathCaret.height >= 12, `caret after a formula placeholder must stay visible: ${JSON.stringify(mathCaret)}`);
    assert.ok(math.placeholders[0].rect.width > 0 && math.placeholders[0].rect.height > 0, 'the placeholder keeps a real box');
    assert.deepEqual(math.errors, []);
    return {boldCaret, openCaret, mathCaret, placeholder: math.placeholders[0].rect};
  });
  await check('tall formulas share final baselines and root height, without bottom clipping', async () => {
    await evaluate(`probe.set(${JSON.stringify('前 $x$ 中 $$\\frac{1}{\\frac{2}{3}}$$ 后')})`);
    await waitFor('probe.root.querySelectorAll("[data-lmm-math]").length === 2 && document.querySelectorAll(".lmm-native-formula").length === 2', 'both formula layouts');
    const state = await evaluate('probe.snapshot()');
    assert.equal(state.formulas.length, 2); assert.equal(state.placeholders.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.ok(Math.abs(state.formulas[i].rect.top - state.placeholders[i].rect.top) < 1);
      assert.equal(state.formulas[i].clip, 'inset(0px)');
      assert.ok(state.formulas[i].rect.bottom <= state.root.bottom + 1);
    }
    return state;
  });
  await check('mouse click exposes TeX using the resident selection and allows editing', async () => {
    await evaluate(`probe.set(${JSON.stringify('公式 $x^2$ 后')})`);
    await waitFor('probe.root.querySelectorAll("[data-lmm-math]").length === 1', 'the clickable formula placeholder');
    const state = await evaluate('probe.snapshot()'), rect = state.placeholders[0].rect;
    await evaluate('window.pointerEvidence=[];document.addEventListener("pointerdown", e=>pointerEvidence.push({target:e.target.outerHTML.slice(0,220),x:e.clientX,y:e.clientY}),{capture:true,once:true})');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.5 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.5 });
    await delay(120);
    const clicked = await evaluate('probe.snapshot()');
    assert.equal(clicked.text, state.text); assert.equal(clicked.formulas.length, 0, `click must reveal editable TeX: ${JSON.stringify({selection:clicked.range,pointer:await evaluate('pointerEvidence'),dom:await evaluate('({text:getSelection().anchorNode?.textContent,offset:getSelection().anchorOffset,html:probe.root.innerHTML})')})}`);
    await call('Input.insertText', { text: 'a' }); await delay(100);
    const edited = await evaluate('probe.snapshot()'); assert.equal(edited.text.length, state.text.length + 1); assert.deepEqual(edited.errors, []);
    return { before: state.text, selection: clicked.range, after: edited.text };
  });
  await check('arrow and deletion cross hidden Markdown delimiters without source loss', async () => {
    await evaluate('probe.set("**bold**")');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await delay(80); const before = await evaluate('probe.snapshot()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await delay(80); const after = await evaluate('probe.snapshot()');
    assert.equal(before.text, '**bold**'); assert.ok(before.range.from < 8); assert.equal(after.text.length, 7); assert.deepEqual(after.errors, []);
    return { before: before.range, after: after.text };
  });
  await check('scrollport clips long formula drafts and repaint never clamps bottom scroll', async () => {
    const text = Array.from({ length: 28 }, (_, i) => `${i} $$\\frac{a}{\\frac{b}{c}}$$`).join('\n');
    await evaluate(`probe.set(${JSON.stringify(text)})`);
    await waitFor('document.querySelectorAll(".lmm-native-formula").length >= 20', 'the long formula draft view');
    await evaluate('probe.scroll.scrollTop=probe.scroll.scrollHeight;probe.wait()');
    const before = await evaluate('probe.snapshot()');
    await evaluate('probe.refresh();probe.wait()'); const after = await evaluate('probe.snapshot()');
    assert.ok(before.maxScroll > 500); assert.ok(Math.abs(before.scrollTop - after.scrollTop) < 1, 'paint must preserve scroll position');
    for (const formula of after.formulas) {
      if (formula.rect.bottom <= after.scroll.top || formula.rect.top >= after.scroll.bottom) assert.notEqual(formula.clip, 'inset(0px)', 'off-scrollport formula must be clipped');
    }
    return { before: before.scrollTop, after: after.scrollTop, max: after.maxScroll, formulas: after.formulas.length };
  });
  await check('closed Chinese code fences paint one full-width region without moving the native caret', async () => {
    const source = '```text\n三个点没有形成正确的闭合和代码块\n第二行 $inside$\n```';
    await evaluate(`probe.set(${JSON.stringify(source)})`);
    await waitFor('document.querySelectorAll(".lmm-native-codeblock").length === 1', 'the continuous code block');
    const before = await evaluate('probe.snapshot()'), caret = await evaluate('probe.caret()');
    assert.equal(before.text, source);
    assert.equal(before.codeblocks.length, 1);
    assert.equal(before.formulas.length, 0, 'code contents stay literal');
    const lineHeight = await evaluate('parseFloat(getComputedStyle(probe.root).lineHeight)');
    assert.ok(before.root.height <= lineHeight * 2 + 24 + 2, 'only body lines and their vertical padding occupy flow height');
    assert.ok(before.codeblocks[0].rect.height <= lineHeight * 2 + 24 + 2, 'the padded frame excludes the fence rows');
    assert.ok(Math.abs(before.codeblocks[0].rect.width - before.root.width) < 1);
    assert.ok(caret.height >= 12, 'the closing fence retains a native caret');
    assert.ok(caret.top >= before.codeblocks[0].rect.top - 3 && caret.top + caret.height <= before.codeblocks[0].rect.bottom + 3, 'the closing caret sits on the body instead of a hidden empty row');
    assert.deepEqual(await evaluate('probe.domRange()'), { anchor: source.length, focus: source.length });
    await evaluate('probe.select(4);probe.wait()');
    const editing = await evaluate('probe.snapshot()');
    assert.equal(editing.text, source);
    assert.equal(editing.codeblocks.length, 1);
    await evaluate(`probe.set(${JSON.stringify('```text\n未闭合')})`);
    await waitFor('document.querySelectorAll(".lmm-native-codeblock").length === 0', 'unfinished fence source');
    const unfinished = await evaluate('probe.snapshot()');
    assert.equal(unfinished.markers.length, 0);
    assert.deepEqual(unfinished.errors, []);
    return { block: before.codeblocks[0], caret, editing: editing.range };
  });
  await check('sent Chinese code renders literal selectable code without a duplicate source surface', async () => {
    const source = '```text\n三个点没有形成正确的闭合和代码块\n$inside$ <b>literal</b>\n```\n外部公式 $x$';
    await evaluate(`(() => {
      const message = document.createElement('div'); message.id = 'sent-code-probe';
      message.setAttribute('data-chat-flow-kind', 'user');
      const run = document.createElement('span'); run.className = 'plainRun'; run.style.whiteSpace = 'pre-wrap';
      run.textContent = ${JSON.stringify(source)}; message.append(run); document.body.append(message);
    })()`);
    try {
      await waitFor('document.querySelector("#sent-code-probe .lmm-chat-codeblock code") && document.querySelector("#sent-code-probe .lmm-chat-formula")', 'sent code and outside formula');
      const state = await evaluate(`(() => {
        const run = document.querySelector('#sent-code-probe .plainRun'), block = run.querySelector('.lmm-chat-codeblock');
        const selection = getSelection(), range = document.createRange(); range.selectNodeContents(block.querySelector('code')); selection.removeAllRanges(); selection.addRange(range);
        const copied = selection.toString(); selection.removeAllRanges();
        const hidden = block.querySelector('.lmm-chat-source');
        return { body: block.querySelector('code').textContent, display: getComputedStyle(block).display,
          hidden: hidden.hidden, sourceDisplay: getComputedStyle(hidden).display,
          formulas: run.querySelectorAll('.lmm-chat-formula').length, tags: block.querySelectorAll('b').length, copied };
      })()`);
      assert.equal(state.body, '三个点没有形成正确的闭合和代码块\n$inside$ <b>literal</b>\n');
      assert.equal(state.display, 'block');
      assert.equal(state.formulas, 1); assert.equal(state.tags, 0);
      assert.equal(state.hidden, true); assert.equal(state.sourceDisplay, 'none');
      assert.equal(state.copied, state.body.replace(/\n$/, ''), 'selection copies visible code once without raw fences');
      return state;
    } finally { await evaluate('document.getElementById("sent-code-probe")?.remove()'); }
  });
  await check('standalone fence rows fold in paragraph and linebreak layouts but expand for source edits', async () => {
    const cases = [];
    for (const paragraphs of [false, true]) {
      for (const body of ['nihao', '\nnihao\n']) {
        await evaluate(`probe.setLines(${JSON.stringify(body)}, ${paragraphs})`);
        const baseline = await evaluate('probe.snapshot()');
        const source = `\`\`\`text\n${body}\n\`\`\``;
        await evaluate(`probe.setLines(${JSON.stringify(source)}, ${paragraphs})`);
        const folded = await evaluate('probe.snapshot()'), caret = await evaluate('probe.caret()');
        assert.equal(folded.text, source);
        const lineHeight = await evaluate('parseFloat(getComputedStyle(probe.root).lineHeight)');
        const expectedHeight = Math.max(baseline.root.height, lineHeight * body.split('\n').length + 24);
        assert.ok(Math.abs(folded.root.height - expectedHeight) <= 2, `only body and padding add flow height: ${JSON.stringify({paragraphs, body, baseline: baseline.root.height, folded: folded.root.height, expectedHeight})}`);
        assert.ok(caret.height >= 12);
        assert.deepEqual(await evaluate('probe.domRange()'), { anchor: source.length, focus: source.length });
        await evaluate('probe.select(1);probe.wait()');
        const opening = await evaluate('probe.snapshot()');
        assert.ok(opening.root.height > folded.root.height + 10, 'the opening source line expands for editing');
        await evaluate(`probe.select(${source.length - 1});probe.wait()`);
        const closing = await evaluate('probe.snapshot()');
        assert.ok(closing.root.height > folded.root.height + 10, 'the closing source line expands for editing');
        assert.ok((await evaluate('probe.caret()')).height >= 12);
        assert.equal(closing.text, source); assert.deepEqual(closing.errors, []);
        cases.push({paragraphs, body, height: folded.root.height, baseline: baseline.root.height, caret});
      }
    }
    return cases;
  });
  await check('drag selections follow visible nihao glyphs in sent block and inline code', async () => {
    const source = '```text\nnihao\n```\n行内 `nihao`\n外部公式 $x$';
    await evaluate(`(() => {
      const message = document.createElement('div'); message.id = 'selection-code-probe';
      message.setAttribute('data-chat-flow-kind', 'user');
      message.style.cssText = 'max-width:560px;margin-top:16px;padding:16px;border-radius:12px;background:#252a34;color:#dbe2ec;user-select:none';
      const run = document.createElement('span'); run.className = 'plainRun'; run.style.whiteSpace = 'pre-wrap';
      run.textContent = ${JSON.stringify(source)}; message.append(run); document.body.append(message);
    })()`);
    const cases = [];
    try {
      await waitFor('document.querySelector("#selection-code-probe .lmm-chat-codeblock code") && document.querySelector("#selection-code-probe .lmm-chat-code > code")', 'both selectable code forms');
      await evaluate('probe.root.blur();probe.wait()');
      await evaluate('document.getElementById("selection-code-probe").scrollIntoView({block:"center"});probe.wait()');
      for (const [selector, from, to] of [['.lmm-chat-codeblock code', 0, 5], ['.lmm-chat-codeblock code', 4, 1], ['.lmm-chat-code > code', 1, 4]]) {
        const endpoints = await evaluate(`(() => {
          getSelection().removeAllRanges();
          const code = document.querySelector('#selection-code-probe ' + ${JSON.stringify(selector)}), node = code.firstChild;
          const point = offset => { const range = document.createRange(); range.setStart(node, offset); range.collapse(true); const r = range.getBoundingClientRect(); return {x:r.left,y:r.top+r.height/2}; };
          const range = document.createRange(); range.setStart(node, Math.min(${from}, ${to})); range.setEnd(node, Math.max(${from}, ${to}));
          const r = range.getBoundingClientRect();
          const start = point(${from}), hit = document.elementFromPoint(start.x + 0.25, start.y);
          return {from:start,to:point(${to}),rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},
            hit:hit && {tag:hit.tagName,cls:hit.className},userSelect:getComputedStyle(code).userSelect};
        })()`);
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endpoints.from.x, y: endpoints.from.y });
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: endpoints.from.x, y: endpoints.from.y, button: 'left', buttons: 1, clickCount: 1 });
        for (let step = 1; step <= 6; step++) await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endpoints.from.x + (endpoints.to.x - endpoints.from.x) * step / 6, y: endpoints.to.y, button: 'left', buttons: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endpoints.to.x, y: endpoints.to.y, button: 'left', buttons: 0, clickCount: 1 });
        await delay(80);
        const selected = await evaluate(`(() => {
          const code = document.querySelector('#selection-code-probe ' + ${JSON.stringify(selector)}), s = getSelection();
          const r = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
          return {text:s.toString(),anchor:code.contains(s.anchorNode),focus:code.contains(s.focusNode),rect:r && {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
        })()`);
        const expected = 'nihao'.slice(Math.min(from, to), Math.max(from, to));
        assert.equal(selected.text, expected, `visible substring selection: ${JSON.stringify({endpoints,selected})}`);
        assert.equal(selected.anchor, true); assert.equal(selected.focus, true);
        for (const edge of ['left','right','top','bottom']) assert.ok(Math.abs(selected.rect[edge] - endpoints.rect[edge]) <= 1.5, `selection ${edge} matches the visible glyphs`);
        cases.push({selector,from,to,selected});
        if (selector === '.lmm-chat-codeblock code' && from === 0) {
          const clip = await evaluate(`(() => { const r = document.getElementById('selection-code-probe').getBoundingClientRect(); return {x:Math.max(0,r.left+scrollX-8),y:Math.max(0,r.top+scrollY-8),width:r.width+16,height:r.height+16,scale:1}; })()`);
          const shot = await call('Page.captureScreenshot', { format: 'png', clip });
          await fs.writeFile(path.join(out, 'sent-code-selection.png'), Buffer.from(shot.data, 'base64'));
        }
      }
      return cases;
    } finally { await evaluate('getSelection().removeAllRanges();document.getElementById("selection-code-probe")?.remove();window.scrollTo(0,0)'); }
  });
  await check('empty code bodies accept real pointer, keyboard and IME input after native Enter', async () => {
    const key = async (name, code, vk, extra = {}) => {
      await call('Input.dispatchKeyEvent', {type:'keyDown',key:name,code,windowsVirtualKeyCode:vk,...extra});
      await call('Input.dispatchKeyEvent', {type:'keyUp',key:name,code,windowsVirtualKeyCode:vk,modifiers:extra.modifiers ?? 0});
    };
    const keys = async text => {
      for (const char of text) await key(char, char === '`' ? 'Backquote' : `Key${char.toUpperCase()}`, char === '`' ? 192 : char.toUpperCase().charCodeAt(0), {text:char,unmodifiedText:char});
    };
    const ime = async text => {
      await call('Input.imeSetComposition', {text:text.slice(0,1),selectionStart:1,selectionEnd:1}); await delay(30);
      await call('Input.imeSetComposition', {text,selectionStart:text.length,selectionEnd:text.length}); await delay(30);
      await call('Input.insertText', {text}); await delay(120);
    };
    const visible = () => evaluate(`(() => {
      const source = [...probe.root.querySelectorAll('[data-lmm-role~=codeblock]')].filter(e => e.getAttribute('data-lmm-hide') !== 'true' && getComputedStyle(e).webkitTextFillColor !== 'rgba(0, 0, 0, 0)' && e.getBoundingClientRect().width > 0).map(e => e.textContent).join('');
      return {source,...probe.project(),dom:probe.domRange(),errors:probe.errors};
    })()`);
    const cases = [];
    for (const paragraphs of [false,true]) for (const info of ['', 'nihao你好']) {
      const source = `\`\`\`${info}\n\n\`\`\``;
      await evaluate(`probe.setLines(${JSON.stringify(source)}, ${paragraphs})`);
      assert.equal((await evaluate('probe.project()')).text, source, 'both resident source layouts are preserved');
      await evaluate('probe.root.blur();probe.wait()');
      const rect = await evaluate('probe.snapshot().codeblocks[0]?.rect');
      assert.ok(rect?.height >= 12, 'an empty body still exposes a native insertion row');
      const x = rect.left + 12, y = rect.top + rect.height / 2;
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
      await delay(120);
      const clicked = await evaluate('probe.project()'), bodyFrom = 4 + info.length;
      assert.equal(clicked.range.from, bodyFrom, `click must enter the body rather than hidden info: ${JSON.stringify({paragraphs,info,clicked})}`);
      await keys('x'); await ime('输入'); await keys('test'); await delay(140);
      const expected = `\`\`\`${info}\nx输入test\n\`\`\``, state = await visible();
      assert.equal(state.text, expected, 'each next key must insert into the actual body');
      assert.ok(state.source.includes('x输入test'), 'typed body glyphs must be visible');
      assert.deepEqual(state.dom, {anchor:expected.length-4,focus:expected.length-4});
      assert.deepEqual(state.errors, []); cases.push({paragraphs,info,text:state.text,range:state.range,visible:state.source});
    }
    await evaluate('probe.set("```js\\nnihao\\n```",5)');
    await keys('x'); await ime('你'); await keys('y'); await delay(120);
    const opening = await visible();
    assert.equal(opening.text, '```jsx你y\nnihao\n```');
    assert.ok(opening.source.includes('```jsx你y'), 'language info stays visible while typing at its end');
    await key('a','KeyA',65,{modifiers:2}); await key('Backspace','Backspace',8); await delay(120);
    assert.equal((await evaluate('probe.project()')).text, '');
    await keys('fresh'); await ime('恢复');
    const fresh = await evaluate('probe.snapshot()');
    assert.equal(fresh.text, 'fresh恢复'); assert.equal(fresh.codeblocks.length, 0); assert.deepEqual(fresh.errors, []);
    return {cases,opening:opening.source,fresh:fresh.text};
  });
  await check('three native backtick keys pair transparent code and two empty Shift+Enter breaks exit', async () => {
    const key = async (name, code, vk, extra = {}) => {
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,windowsVirtualKeyCode:vk,...extra});
      await call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:vk,modifiers:extra.modifiers ?? 0});
    };
    const keys = async text => { for (const char of text) await key(char,char === '`' ? 'Backquote' : `Key${char.toUpperCase()}`,char === '`' ? 192 : char.toUpperCase().charCodeAt(0),{text:char,unmodifiedText:char}); };
    const ime = async text => {
      await call('Input.imeSetComposition',{text:text.slice(0,1),selectionStart:1,selectionEnd:1}); await delay(30);
      await call('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length}); await delay(30);
      await call('Input.insertText',{text}); await delay(120);
    };
    const lineBreak = async () => { await key('Enter','Enter',13,{modifiers:8}); await delay(120); };
    const finish = async () => {
      const before = await evaluate('probe.project()');
      await lineBreak();
      const inside = await evaluate('probe.project()');
      assert.equal(inside.text,before.text.slice(0,before.range.to)+'\n'+before.text.slice(before.range.to),'first Shift+Enter stays inside code');
      assert.equal(inside.range.from,before.range.to+1);
      await lineBreak();
    };
    try {
      await evaluate('probe.root.style.color="#eeeeef";probe.root.style.backgroundColor="#14171b";probe.set("")');
      await keys('```'); await delay(160);
      const empty = await evaluate(`(() => {
        const state = probe.snapshot(), anchor = probe.root.querySelector('[data-lmm-code-backdrop]');
        return {...state,dom:probe.domRange(),hidden:[...probe.root.querySelectorAll('[data-lmm-hide]')].map(e => getComputedStyle(e).webkitTextFillColor),background:getComputedStyle(anchor,'::before').backgroundColor};
      })()`);
      assert.equal(empty.text,'```\n\n```'); assert.equal(empty.range.from,4);
      assert.deepEqual(empty.dom,{anchor:4,focus:4});
      assert.equal(empty.codeblocks.length,1); assert.ok(empty.codeblocks[0].rect.height >= 44);
      assert.equal(empty.hidden.length,2); assert.ok(empty.hidden.every(color => color === 'rgba(0, 0, 0, 0)'));
      assert.equal(empty.background,'rgb(48, 48, 52)');
      await evaluate('probe.root.blur();probe.wait()');
      const box = (await evaluate('probe.snapshot()')).codeblocks[0].rect, x = box.left + 8, y = box.top + box.height/2;
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
      await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}); await delay(100);
      assert.equal((await evaluate('probe.project()')).range.from,4,'clicking empty gray padding enters its real body paragraph');
      await keys('nihao'); await ime('你好'); await keys('x'); await delay(100);
      const code = '```\nnihao你好x\n```', typed = await evaluate('probe.snapshot()');
      assert.equal(typed.text,code); assert.equal(typed.range.from,code.length-4);
      assert.equal(typed.markers.length,2); assert.ok((await evaluate('probe.caret()')).height >= 12);
      await finish();
      const outside = await evaluate('probe.project()');
      assert.equal(outside.text,`${code}\n`); assert.equal(outside.range.from,code.length+1,'Shift+Enter creates one line after the closing fence');
      await keys('after'); await ime('外部');
      assert.equal((await evaluate('probe.project()')).text,`${code}\nafter外部`);
      const rect = await evaluate('probe.snapshot().root');
      const shot = await call('Page.captureScreenshot',{format:'png',clip:{x:Math.max(0,rect.left-8),y:Math.max(0,rect.top-8),width:rect.width+16,height:rect.height+16,scale:1}});
      await fs.writeFile(path.join(out,'code-auto-gray.png'),Buffer.from(shot.data,'base64'));
      await evaluate(`probe.setLines(${JSON.stringify('before\n')},false)`); await keys('```'); await delay(120);
      assert.equal((await evaluate('probe.project()')).text,'before\n```\n\n```','a previous BR line stays exactly one paragraph gap');
      await keys('z'); await finish(); await keys('tail');
      assert.equal((await evaluate('probe.project()')).text,'before\n```\nz\n```\ntail');
      await evaluate(`probe.setLines(${JSON.stringify('``\nafter')},false);probe.select(2);probe.wait()`);
      await keys('`'); await delay(120);
      assert.equal((await evaluate('probe.project()')).text,'```\n\n```\nafter','existing following content stays outside');
      await finish(); await keys('X');
      assert.equal((await evaluate('probe.project()')).text,'```\n\n```\nXafter','exit reuses the existing following line');
      await evaluate('probe.set("")');
      await call('Input.insertText',{text:'```js\nnihao\n```'}); await delay(120);
      assert.equal((await evaluate('probe.project()')).text,'```js\nnihao\n```','bulk insertion does not add another paired fence');
      assert.deepEqual(await evaluate('probe.errors'),[]);
      return {empty:{source:empty.text,caret:empty.range.from,height:empty.codeblocks[0].rect.height,background:empty.background},typed:typed.text,outside:outside.text,prefix:true,following:true,bulk:true};
    } finally { await evaluate('probe.root.style.removeProperty("color");probe.root.style.removeProperty("background-color")'); }
  });
  await check('multiline native code keeps single breaks and removes only the final exit row', async () => {
    const key = async (name, code, vk, extra = {}) => {
      await call('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,windowsVirtualKeyCode:vk,...extra});
      await call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:vk,modifiers:extra.modifiers ?? 0});
    };
    const keys = async text => { for (const char of text) await key(char,char === '`' ? 'Backquote' : `Key${char.toUpperCase()}`,char === '`' ? 192 : char.toUpperCase().charCodeAt(0),{text:char,unmodifiedText:char}); };
    const lineBreak = async () => { await key('Enter','Enter',13,{modifiers:8}); await delay(120); };
    try {
      await evaluate('probe.root.style.color="#eeeeef";probe.root.style.backgroundColor="#14171b";probe.set("")');
      await keys('```'); await delay(120); await keys('one'); await lineBreak();
      const first = await evaluate('probe.snapshot()');
      assert.equal(first.text,'```\none\n\n```'); assert.equal(first.range.from,8);
      assert.deepEqual(await evaluate('probe.domRange()'),{anchor:8,focus:8});
      assert.equal(first.markers.length,2,'the first blank body row keeps its fences hidden');
      await keys('two');
      await call('Input.imeSetComposition',{text:'二',selectionStart:1,selectionEnd:1}); await delay(30);
      await call('Input.imeSetComposition',{text:'二行',selectionStart:2,selectionEnd:2}); await delay(30);
      await call('Input.insertText',{text:'二行'}); await delay(120);
      const code = '```\none\ntwo二行\n```', filled = await evaluate('probe.snapshot()');
      assert.equal(filled.text,code); assert.equal(filled.range.from,code.length-4);
      assert.ok(filled.codeblocks[0].rect.height >= 70,'two actual code lines remain within the gray block');
      await lineBreak();
      const blank = await evaluate('probe.snapshot()');
      assert.equal(blank.text,'```\none\ntwo二行\n\n```');
      assert.ok(blank.codeblocks[0].rect.height >= filled.codeblocks[0].rect.height+20,'the first break has a real editable blank row');
      await lineBreak();
      const exited = await evaluate('probe.snapshot()');
      assert.equal(exited.text,`${code}\n`,'exit removes the temporary blank row before the closing marker');
      assert.equal(exited.range.from,code.length+1);
      assert.ok(Math.abs(exited.codeblocks[0].rect.height-filled.codeblocks[0].rect.height) <= 2,'the gray block shrinks back to its two content lines');
      await keys('outside'); await delay(120);
      assert.equal((await evaluate('probe.project()')).text,`${code}\noutside`);
      assert.deepEqual(await evaluate('probe.errors'),[]);
      const rect = await evaluate('probe.snapshot().root');
      const shot = await call('Page.captureScreenshot',{format:'png',clip:{x:Math.max(0,rect.left-8),y:Math.max(0,rect.top-8),width:rect.width+16,height:rect.height+16,scale:1}});
      await fs.writeFile(path.join(out,'code-multiline-gray.png'),Buffer.from(shot.data,'base64'));
      return {first:first.text,multiline:filled.text,blank:blank.text,exited:exited.text,height:{filled:filled.codeblocks[0].rect.height,blank:blank.codeblocks[0].rect.height,exited:exited.codeblocks[0].rect.height}};
    } finally { await evaluate('probe.root.style.removeProperty("color");probe.root.style.removeProperty("background-color")'); }
  });
  await check('code pills reserve padding below native glyphs and clear the following line in both themes', async () => {
    const cases = [];
    try {
      for (const paragraphs of [false,true]) for (const scheme of ['light','dark','normal']) {
        await evaluate(`document.documentElement.style.colorScheme=${JSON.stringify(scheme)};probe.root.style.color=${JSON.stringify(scheme !== 'light' ? '#eeeeef' : '#182230')};probe.root.style.backgroundColor=${JSON.stringify(scheme !== 'light' ? '#303030' : '#ffffff')}`);
        await evaluate(`probe.setLines(${JSON.stringify('```\n你好\n```\n下一行')}, ${paragraphs})`);
        const state = await evaluate(`(() => {
          const box = probe.snapshot().codeblocks[0].rect, anchor = probe.root.querySelector('[data-lmm-code-backdrop]');
          const body = document.createRange(); body.selectNodeContents(anchor); const r = body.getBoundingClientRect();
          const walker = document.createTreeWalker(probe.root,NodeFilter.SHOW_TEXT); let node;
          while ((node = walker.nextNode()) && node.textContent !== '下一行') {}
          const tail = document.createRange(); tail.selectNodeContents(node); const after = tail.getBoundingClientRect();
          const style = getComputedStyle(anchor,'::before');
          return {box,body:{left:r.left,top:r.top,bottom:r.bottom},tail:{top:after.top},radius:style.borderRadius,background:style.backgroundColor,text:probe.project().text,errors:probe.errors};
        })()`);
        assert.ok(state.box.height >= 44, 'one code line has enough vertical breathing room');
        assert.ok(Math.abs(state.body.left - state.box.left - 16) <= 1.5, 'body text keeps its 16px inset under host paragraph styles');
        assert.ok(state.body.top - state.box.top >= 11, 'top padding is real native flow');
        assert.ok(state.box.bottom - state.body.bottom >= 11, 'bottom padding is real native flow');
        assert.ok(state.tail.top >= state.box.bottom, 'the next line stays outside the pill');
        assert.equal(state.radius,'24px');
        assert.equal(state.background, 'rgb(48, 48, 52)');
        assert.deepEqual(state.errors, []);
        if (paragraphs) {
          const rect = await evaluate('probe.snapshot().root');
          const shot = await call('Page.captureScreenshot',{format:'png',clip:{x:Math.max(0,rect.left-8),y:Math.max(0,rect.top-8),width:rect.width+16,height:rect.height+16,scale:1}});
          await fs.writeFile(path.join(out,`code-pill-${scheme}.png`),Buffer.from(shot.data,'base64'));
        }
        cases.push({paragraphs,scheme,...state});
      }
      return cases;
    } finally { await evaluate('document.documentElement.style.colorScheme="";probe.root.style.removeProperty("color");probe.root.style.removeProperty("background-color")'); }
  });
  await check('selection-only movements do not rewrite native source or replace root', async () => {
    await evaluate('probe.set("**文字** $x$ 😀")');
    const before = await evaluate('probe.project()');
    await evaluate('probe.select(1, 10);probe.wait()');
    const after = await evaluate('probe.snapshot()'); assert.equal(after.text, before.text); assert.deepEqual(after.errors, []);
    assert.equal(await evaluate('probe.editor.getRootElement()===document.getElementById("editor")'), true);
  });
  await evaluate(`probe.set(${JSON.stringify('# 原生无感输入\n**粗体**、_斜体_、`code` 与公式 $E=mc^2$\n```text\n三个点形成闭合的代码块\n第二行保留原文\n```\n> 图片、附件与发送仍由 DSH 管理')})`);
  await waitFor('probe.root.querySelector("[data-lmm-role~=h1]") && document.querySelectorAll(".lmm-native-formula").length === 1', 'the final rendered preview');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, 'native-preview.png'), Buffer.from(screenshot.data, 'base64'));
  await check('candidate lifecycle unload removes enhancement and preserves native source', async () => {
    const before = await evaluate('probe.project().text');
    await evaluate('probe.unmountPlugin()');
    const state = await evaluate(`({text: probe.project().text, root: probe.editor.getRootElement() === probe.root, enhanced: probe.root.hasAttribute('data-lmm-native'), layers: document.querySelectorAll('.lmm-native-layer').length, styles: document.querySelectorAll('style[data-plugin="dsh-live-markdown-math"]').length, errors: probe.errors})`);
    assert.equal(state.text, before); assert.equal(state.root, true); assert.equal(state.enhanced, false);
    assert.equal(state.layers, 0); assert.equal(state.styles, 0); assert.deepEqual(state.errors, []);
    return state;
  });
  await evaluate('probe.dispose()');
  await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify({ browser: 'isolated installed Chrome; not live DSH GUI', results }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(r => r.passed), 'Native browser probe contains failures');
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close', {}, null).catch(() => {}); socket.close(); }
  if (child.exitCode === null) child.kill();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Isolated browser closed')); }
}
