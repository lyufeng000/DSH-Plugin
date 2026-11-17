import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDOM } from './dom.mjs';
import { renderChatMath, createChatMath, CHAT_MATH_MARK } from '../src/chat-math.mjs';

/** One document shaped like the live conversation: a user bubble and an assistant step. */
function build(text) {
  const dom = setupDOM(), doc = dom.window.document;
  doc.body.innerHTML = '<div data-chat-flow="">'
    + '<div data-chat-flow-kind="user" data-chat-node-key="13:input-message1">'
    + '<div data-slot="conversation.chat.node"><div class="bubble"><span class="plainRun"></span></div></div></div>'
    + '<div data-chat-flow-kind="assistant-step">'
    + '<div data-slot="conversation.chat.node"><div class="markdown"><p><code>$x$</code></p></div></div></div>'
    + '</div>';
  const user = doc.querySelector('[data-chat-flow-kind="user"]');
  user.querySelector('.plainRun').textContent = text;
  return {dom, doc, user, run: user.querySelector('.plainRun'), assistant: doc.querySelector('[data-chat-flow-kind="assistant-step"]')};
}

const formulaCount = run => run.querySelectorAll('.lmm-chat-formula').length;
const sourceText = run => [...run.childNodes].map(node => node.nodeType === 3
  ? node.data : node.querySelector('.lmm-chat-source')?.textContent ?? node.textContent).join('');
function assertSelectableCode(wrapper) {
  const raw = wrapper.querySelector('.lmm-chat-source');
  assert.equal(raw.hidden, true, 'raw code has no layout or selection surface');
  assert.equal(raw.getAttribute('aria-hidden'), 'true');
  assert.equal(raw.style.userSelect, 'none');
  assert.equal(raw.style.pointerEvents, 'none');
  const win = wrapper.ownerDocument.defaultView;
  assert.equal(win.getComputedStyle(raw).display, 'none');
  for (const node of [wrapper, ...wrapper.querySelectorAll('pre, code')]) {
    assert.equal(win.getComputedStyle(node).userSelect, 'text', 'visible code overrides ancestor selection rules');
    assert.equal(win.getComputedStyle(node).pointerEvents, 'auto');
  }
  return wrapper.querySelector('code');
}
async function until(check) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= end) assert.fail('chat math did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a sent user message renders its formula without touching anything else', () => {
  const {dom, doc, user, run} = build('测试 $\\frac{1}{2}$ 结束');
  assert.equal(renderChatMath(doc), 1);
  const formula = user.querySelector('.lmm-chat-formula');
  assert.ok(formula, 'the formula is rendered');
  assert.ok(formula.querySelector('.katex'), 'through KaTeX');
  // Copy fidelity: the source run stays in the DOM and the rendered markup is
  // excluded from selection, so selecting the message yields what was typed.
  assert.equal(formula.querySelector('.lmm-chat-source').textContent, '$\\frac{1}{2}$');
  assert.equal(formula.querySelector('.katex').style.userSelect, 'none');
  assert.ok(run.hasAttribute(CHAT_MATH_MARK));
  assert.equal(user.textContent.includes('结束'), true, 'the surrounding text survives');
  assert.equal(formula.previousSibling.textContent, '测试 ');
  assert.equal(renderChatMath(doc), 0, 'a second pass finds nothing to do');
  dom.window.close();
});

test('assistant markdown is never touched', () => {
  const {dom, doc, assistant} = build('nothing here');
  renderChatMath(doc);
  assert.equal(assistant.querySelector('code').textContent, '$x$');
  assert.equal(assistant.querySelector('.lmm-chat-formula'), null);
  dom.window.close();
});

test('incomplete or non-math dollar signs stay exactly as typed', () => {
  for (const text of ['价格是 $5 和 $6', '$\\frac{1}{2}', 'costs $HOME now', 'no math here']) {
    const {dom, doc, run} = build(text);
    assert.equal(renderChatMath(doc), 0, 'nothing renders for: ' + text);
    assert.equal(run.textContent, text);
    dom.window.close();
  }
});

test('rendering is idempotent and repairs a repaint', async () => {
  const {dom, doc, user, run} = build('公式 $x^2$ 后');
  assert.equal(renderChatMath(doc), 1);
  assert.ok(run.hasAttribute(CHAT_MATH_MARK));
  // The app repaints the bubble with the raw text: our marker goes with it.
  run.replaceChildren(doc.createTextNode('公式 $x^2$ 后'));
  assert.equal(renderChatMath(doc), 1, 'repaired right away');
  run.replaceChildren(doc.createTextNode('公式 $x^2$ 后'));
  const watcher = createChatMath(doc, {debounce: 10});
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(user.querySelectorAll('.lmm-chat-formula').length, 1, 'repaired after a repaint');
  watcher.dispose();
  assert.doesNotThrow(() => watcher.run());
  dom.window.close();
});

test('display-only rendering never throws on hostile text and injects no markup', () => {
  const {dom, doc, run} = build('');
  run.textContent = '$$$$$ $\\frac{$ <img src=x onerror=alert(1)> $a$';
  assert.doesNotThrow(() => renderChatMath(doc));
  assert.equal(doc.querySelectorAll('img').length, 0, 'no markup from the message is executed');
  assert.equal(doc.querySelectorAll('script').length, 0);
  dom.window.close();
});

for (const count of [81, 200]) test(`bounded passes finish all ${count} formulas and preserve original source nodes`, () => {
  const text = Array(count).fill('$x$').join(' ');
  const {dom, doc, run} = build(text), original = run.firstChild;
  try {
    assert.equal(renderChatMath(doc), 80);
    assert.equal(formulaCount(run), 80);
    assert.equal(sourceText(run), text);
    const firstWrapper = run.querySelector('.lmm-chat-formula');
    let total = 80, passes = 0;
    while (total < count) {
      const applied = renderChatMath(doc);
      assert.ok(applied > 0 && applied <= 80);
      total += applied;
      assert.ok(++passes <= 2, 'pending work must make progress');
      assert.equal(sourceText(run), text);
    }
    assert.equal(formulaCount(run), count);
    assert.equal(run.querySelector('.lmm-chat-formula'), firstWrapper, 'continuation keeps earlier wrappers');
    assert.equal(renderChatMath(doc), 0);
    const watcher = createChatMath(doc);
    watcher.dispose();
    assert.equal(run.firstChild, original, 'dispose reuses the original native Text node');
    assert.equal(run.childNodes.length, 1);
    assert.equal(run.textContent, text);
  } finally { dom.window.close(); }
});

test('one pass shares its budget across messages and resumes without external mutations', async () => {
  const text = Array(81).fill('$x$').join(' ');
  const {dom, doc, user, run} = build(text);
  const second = user.cloneNode(true), third = user.cloneNode(true);
  user.after(second, third);
  const runs = [run, second.querySelector('.plainRun'), third.querySelector('.plainRun')];
  const originals = runs.map(node => node.firstChild);
  let watcher;
  try {
    watcher = createChatMath(doc, {debounce: 5});
    const initial = runs.map(formulaCount);
    assert.equal(initial.reduce((a, b) => a + b, 0), 80);
    assert.ok(Math.max(...initial) - Math.min(...initial) <= 1, 'messages receive round-robin work');
    await until(() => runs.every(node => formulaCount(node) === 81));
    assert.ok(runs.every(node => sourceText(node) === text));
    // Drained work must not manufacture an endless observation/timer cycle.
    let scheduled = 0;
    const nativeSetTimeout = dom.window.setTimeout;
    dom.window.setTimeout = (...args) => { scheduled++; return nativeSetTimeout.apply(dom.window, args); };
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(scheduled, 0);
    watcher.dispose();
    for (let i = 0; i < runs.length; i++) assert.equal(runs[i].firstChild, originals[i]);
  } finally { watcher?.dispose(); dom.window.close(); }
});

test('a repaint cancels pending old formulas and dispose preserves the new native Text node', async () => {
  const {dom, doc, run} = build(Array(200).fill('$x$').join(' '));
  const watcher = createChatMath(doc, {debounce: 5});
  try {
    assert.equal(formulaCount(run), 80);
    const latest = doc.createTextNode('新内容 $y$，旧公式全部移除');
    run.replaceChildren(latest);
    await until(() => formulaCount(run) === 1);
    assert.equal(sourceText(run), latest.data);
    assert.equal(run.querySelector('.lmm-chat-source').textContent, '$y$');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(formulaCount(run), 1, 'the obsolete queue cannot put x formulas back');
    watcher.dispose();
    assert.equal(run.firstChild, latest);
    assert.equal(run.textContent, latest.data);
  } finally { watcher.dispose(); dom.window.close(); }
});

test('dispose cancels continuation and preserves a foreign edit to the remaining source', async () => {
  const text = Array(200).fill('$x$').join(' ');
  const {dom, doc, run} = build(text);
  const watcher = createChatMath(doc, {debounce: 5});
  try {
    assert.equal(formulaCount(run), 80);
    run.lastChild.data = ' 最新外部内容';
    const latest = sourceText(run);
    watcher.dispose();
    assert.equal(run.textContent, latest);
    assert.equal(formulaCount(run), 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(run.textContent, latest);
    assert.equal(run.hasAttribute(CHAT_MATH_MARK), false);
  } finally { watcher.dispose(); dom.window.close(); }
});

test('invalid TeX shares the work budget and cannot starve a later valid formula', async () => {
  const text = [...Array(80).fill('$\\unsupportedMacro$'), '$y$'].join(' ');
  const {dom, doc, run} = build(text);
  const watcher = createChatMath(doc, {debounce: 5});
  try {
    assert.equal(formulaCount(run), 0, 'the first pass attempts at most 80 formulas');
    await until(() => formulaCount(run) === 1);
    assert.equal(run.querySelector('.lmm-chat-source').textContent, '$y$');
    assert.equal(sourceText(run), text);
    watcher.dispose();
    assert.equal(run.textContent, text);
  } finally { watcher.dispose(); dom.window.close(); }
});

test('continuation keeps full-message Markdown exclusions across the budget boundary', () => {
  const text = `${Array(80).fill('$x$').join(' ')}\n\n\`$inline$\`\n\n\`\`\`tex\n$fenced$\n\`\`\`\n\n$y$`;
  const {dom, doc, run} = build(text);
  try {
    assert.equal(renderChatMath(doc), 80);
    assert.equal(renderChatMath(doc), 3, 'inline code, fenced code and the final formula share the next pass');
    assert.equal(formulaCount(run), 81);
    assert.equal(run.querySelectorAll('.lmm-chat-formula .lmm-chat-source')[80].textContent, '$y$');
    assert.equal(run.querySelector('.lmm-chat-code > code').textContent, '$inline$');
    assert.equal(run.querySelector('.lmm-chat-codeblock code').textContent, '$fenced$\n');
    assert.equal(sourceText(run), text);
    const watcher = createChatMath(doc);
    watcher.dispose();
    assert.equal(run.textContent, text);
  } finally { dom.window.close(); }
});

test('native ranges select visible fenced and inline code under non-selectable ancestors', () => {
  for (const [source, body] of [
    ['```\nnihao\n```', 'nihao\n'],
    ['```js\r\nnihao\r\n```\r\n', 'nihao\n'],
    ['`nihao`', 'nihao'],
    ['`` nihao ``', 'nihao'],
  ]) {
    const {dom, doc, run} = build(source);
    try {
      const style = doc.createElement('style');
      style.textContent = '.bubble, .plainRun { user-select: none; pointer-events: none; }'
        + '.lmm-chat-source { position: absolute; inset: 0; color: transparent; white-space: pre; overflow: hidden; }';
      doc.head.append(style);
      assert.equal(renderChatMath(doc), 1);
      const wrapper = run.querySelector('.lmm-chat-code, .lmm-chat-codeblock');
      const code = assertSelectableCode(wrapper), raw = wrapper.querySelector('.lmm-chat-source');
      assert.equal(raw.textContent, source, 'original delimiters remain available for restoration');
      assert.equal(code.textContent, body);
      const range = doc.createRange(), selection = doc.getSelection();
      range.setStart(code.firstChild, 0);
      range.setEnd(code.firstChild, 5);
      selection.addRange(range);
      assert.equal(selection.toString(), 'nihao', 'a code-only range contains one visible body without fences');
      range.setStart(code.firstChild, 1);
      range.setEnd(code.firstChild, 4);
      assert.equal(selection.toString(), 'iha', 'partial code selection keeps exact character offsets');
      assert.equal(selection.anchorNode, code.firstChild);
      assert.equal(selection.focusNode, code.firstChild);
      assert.equal(sourceText(run), source);
    } finally { dom.window.close(); }
  }
});

test('mixed code and formulas keep their selection sources separate and restore exact native text', () => {
  const source = '前 $x$ 和 `nihao`\n\n```js\nnihao\n```\n后 $y$';
  const {dom, doc, run} = build(source), original = run.firstChild;
  try {
    assert.equal(renderChatMath(doc), 4);
    const codes = [...run.querySelectorAll('.lmm-chat-code, .lmm-chat-codeblock')];
    assert.equal(codes.length, 2);
    codes.forEach(assertSelectableCode);
    for (const formula of run.querySelectorAll('.lmm-chat-formula')) {
      const raw = formula.querySelector('.lmm-chat-source');
      assert.equal(raw.hidden, false, 'formula source stays selectable as before');
      assert.equal(raw.getAttribute('aria-hidden'), 'false');
      assert.equal(raw.style.userSelect, '');
      for (const node of formula.querySelectorAll('.lmm-formula, .katex')) {
        assert.equal(node.style.userSelect, 'none');
        assert.equal(node.style.pointerEvents, 'none');
      }
    }
    assert.equal(sourceText(run), source);
    const watcher = createChatMath(doc);
    watcher.dispose();
    assert.equal(run.childNodes.length, 1);
    assert.equal(run.firstChild, original);
    assert.equal(run.textContent, source);
  } finally { dom.window.close(); }
});

test('sent closed Chinese fences render a code block and restore the original text node', () => {
  for (const fence of ['```', '~~~', '````']) {
    const source = `${fence}\n三个点没有形成正确的闭合和代码块\n${fence}`;
    const {dom, doc, run} = build(source), original = run.firstChild;
    try {
      assert.equal(renderChatMath(doc), 1);
      const block = run.querySelector('.lmm-chat-codeblock');
      assert.ok(block?.querySelector('pre > code'));
      assert.equal(block.querySelector('code').textContent, '三个点没有形成正确的闭合和代码块\n');
      assertSelectableCode(block);
      assert.equal(block.querySelector('.lmm-chat-source').textContent, source);
      assert.equal(sourceText(run), source);
      assert.equal(renderChatMath(doc), 0);
      const watcher = createChatMath(doc);
      watcher.dispose();
      assert.equal(run.firstChild, original);
      assert.equal(run.textContent, source);
    } finally { dom.window.close(); }
  }
});

test('fenced code preserves blank lines and owns exactly one following source newline', () => {
  for (const [source, body, raw] of [
    ['```\n\n中文\n\n```\n后文', '\n中文\n\n', '```\n\n中文\n\n```\n'],
    ['```\n```\n\n后文', '', '```\n```\n'],
    ['```text\r\n中文\r\n```\r\n后文', '中文\n', '```text\r\n中文\r\n```\r\n'],
  ]) {
    const {dom, doc, run} = build(source);
    try {
      assert.equal(renderChatMath(doc), 1);
      const block = run.querySelector('.lmm-chat-codeblock');
      assert.equal(block.querySelector('code').textContent, body);
      assert.equal(block.querySelector('.lmm-chat-source').textContent, raw);
      assert.equal(sourceText(run), source);
    } finally { dom.window.close(); }
  }
});

test('sent code treats HTML and TeX literally while an outside formula still renders', () => {
  const source = '前文 $x$\n\n```html\n<img src=x onerror=alert(1)>\n$inside$\n```\n\n后文 $y$';
  const {dom, doc, run} = build(source);
  try {
    assert.equal(renderChatMath(doc), 3);
    assert.equal(formulaCount(run), 2);
    const block = run.querySelector('.lmm-chat-codeblock');
    assert.equal(block.querySelector('code').textContent, '<img src=x onerror=alert(1)>\n$inside$\n');
    assert.equal(block.querySelector('.katex'), null);
    assert.equal(run.querySelector('img'), null);
    assert.equal(sourceText(run), source);
  } finally { dom.window.close(); }
});

test('single-line triple backticks remain inline code and incomplete fences stay source', () => {
  const {dom, doc, run} = build('```中文```');
  try {
    assert.equal(renderChatMath(doc), 1);
    assert.equal(run.querySelector('.lmm-chat-code > code').textContent, '中文');
    assert.equal(run.querySelector('pre'), null);
    assert.equal(sourceText(run), '```中文```');
    for (const source of ['```', '```text\n中文', '~~~~\n中文\n~~~']) {
      run.textContent = source;
      assert.equal(renderChatMath(doc), 0);
      assert.equal(run.textContent, source);
      assert.equal(run.querySelector('.lmm-chat-codeblock'), null);
    }
  } finally { dom.window.close(); }
});

test('code repaint cancels pending stale wrappers and dispose keeps the new source node', async () => {
  const {dom, doc, run} = build(Array(200).fill('`旧代码`').join(' '));
  const watcher = createChatMath(doc, {debounce: 5});
  try {
    assert.equal(run.querySelectorAll('code').length, 80);
    assertSelectableCode(run.querySelector('.lmm-chat-code'));
    const latest = doc.createTextNode('```js\nconst value = 2;\n```\n$x$');
    run.replaceChildren(latest);
    await until(() => run.querySelector('code')?.textContent === 'const value = 2;\n' && formulaCount(run) === 1);
    assertSelectableCode(run.querySelector('.lmm-chat-codeblock'));
    assert.equal(sourceText(run), latest.data);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(run.querySelectorAll('code').length, 1, 'the old pending code queue stays cancelled');
    watcher.dispose();
    assert.equal(run.firstChild, latest);
    assert.equal(run.textContent, latest.data);
  } finally { watcher.dispose(); dom.window.close(); }
});

test('code and formula work share the same bounded queue and preserve every source span', () => {
  const source = [...Array(81).fill('`代码`'), '$x$'].join(' ');
  const {dom, doc, run} = build(source);
  try {
    assert.equal(renderChatMath(doc), 80);
    assert.equal(run.querySelectorAll('.lmm-chat-code').length, 80);
    assert.equal(formulaCount(run), 0);
    const first = run.querySelector('.lmm-chat-code');
    assert.equal(sourceText(run), source);
    run.querySelectorAll('.lmm-chat-code').forEach(assertSelectableCode);
    assert.equal(renderChatMath(doc), 2);
    assert.equal(run.querySelectorAll('.lmm-chat-code').length, 81);
    assert.equal(run.querySelector('.lmm-chat-code'), first, 'continuation preserves native selection nodes');
    run.querySelectorAll('.lmm-chat-code').forEach(assertSelectableCode);
    assert.equal(formulaCount(run), 1);
    assert.equal(sourceText(run), source);
    const watcher = createChatMath(doc);
    watcher.dispose();
    assert.equal(run.textContent, source);
  } finally { dom.window.close(); }
});

test('dispose restores raw code after a partial foreign edit and cancels pending code work', async () => {
  const {dom, doc, run} = build(Array(200).fill('`nihao`').join(' '));
  const watcher = createChatMath(doc, {debounce: 5});
  try {
    assert.equal(run.querySelectorAll('code').length, 80);
    run.lastChild.data = ' 最新外部内容';
    const latest = sourceText(run);
    watcher.dispose();
    assert.equal(run.textContent, latest, 'restoration uses raw delimiters instead of duplicate rendered bodies');
    assert.equal(run.querySelector('code, .lmm-chat-source'), null);
    assert.equal(run.hasAttribute(CHAT_MATH_MARK), false);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(run.textContent, latest);
    assert.equal(watcher.run(), 0);
  } finally { watcher.dispose(); dom.window.close(); }
});

test('a partial external repaint invalidates continuation without overwriting its new text', async () => {
  const {dom, doc, run} = build(Array(200).fill('$x$').join(' '));
  const watcher = createChatMath(doc, {debounce: 5});
  try {
    assert.equal(formulaCount(run), 80);
    run.lastChild.data = ' 外部更新 $y$';
    const latest = sourceText(run);
    await until(() => formulaCount(run) === 0);
    assert.equal(run.textContent, latest);
    assert.equal(run.hasAttribute(CHAT_MATH_MARK), false);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(run.textContent, latest, 'no pending old formula writes survive the repaint');
    watcher.dispose();
    assert.equal(run.textContent, latest);
  } finally { watcher.dispose(); dom.window.close(); }
});
