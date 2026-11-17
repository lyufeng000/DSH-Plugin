/**
 * View-only code and TeX rendering for sent user messages.
 *
 * DSH renders a user turn as a plain run of text (`[data-chat-flow-kind="user"]`),
 * so code and formulas the composer previews are shown verbatim once sent.
 * This module renders them in place, at the display layer only: the
 * message data, the submit path and every other part of the shipped bubble stay
 * untouched. The original source stays in the DOM for restoration. Code uses
 * its visible text for native selection; formulas keep selectable source text
 * while their rendered HTML and MathML stay excluded from selection.
 *
 * The grammar is the composer's own, so what renders while typing is what renders
 * after sending. Per-document work resumes across bounded passes, while an app
 * repaint invalidates the old work before the new source is analyzed.
 */
import { analyzeMarkdown } from './markdown.mjs';
import { renderFormula } from './math.mjs';

export const CHAT_MATH_MARK = 'data-lmm-chat-math';
const USER_MESSAGE = '[data-chat-flow-kind="user"]';
// DSH projectUserText owns a CSS-module plainRun span with one string child.
// Fail open if that private display seam changes; never search arbitrary labels.
const SKIP = 'pre, code, [contenteditable], [data-ref-chip], [data-message-attachments], button, a, [role="button"], .katex, .lmm-chat-formula';
const MAX_RENDERS = 80;
const documents = new WeakMap();
const stateFor = doc => {
  let state = documents.get(doc);
  if (!state) { state = { records: new Map(), pending: [] }; documents.set(doc, state); }
  return state;
};
const intact = (element, record) => element.childNodes.length === record.rendered.length &&
  record.rendered.every((node, i) => element.childNodes[i] === node &&
    (node.nodeType !== 3 || node.data === record.texts[i]));
function restoreRun(element, record) {
  // Reuse the original native Text node. Never restore stale text over a newer
  // React repaint; partial foreign changes only get our own wrappers unwrapped.
  if (intact(element, record)) element.replaceChildren(...record.original);
  else for (const [wrapper, source] of record.replacements) {
    if (wrapper.parentNode === element) wrapper.replaceWith(element.ownerDocument.createTextNode(source));
  }
  element.removeAttribute(CHAT_MATH_MARK);
}

/** Innermost text-carrying elements of the user messages that still need work. */
function candidates(doc) {
  const found = [];
  for (const message of doc.querySelectorAll(USER_MESSAGE)) {
    for (const element of message.querySelectorAll('span[class]')) {
      // Reviewed production CSS: ._plainRun_fbulu_6 (CSS-module name/hash/line).
      if (![...element.classList].some(name => name === 'plainRun' || /^_plainRun_[a-zA-Z0-9]+_\d+$/.test(name))) continue;
      if (element.childNodes.length !== 1 || element.firstChild.nodeType !== 3) continue;
      // Only the native one-string-child contract is safe for React repainting.
      const text = element.textContent;
      if (!/[$\\`~]/.test(text)) continue;
      if (element.closest(SKIP)) continue;
      found.push(element);
    }
  }
  return found;
}

/** Parser-owned code ranges omit list/quote prefixes between source lines. */
function fencedText(text, fence) {
  const newline = /\r\n?|\n/.exec(text.slice(fence.open.to, fence.close.from));
  let body = '', end = fence.open.to + newline.index + newline[0].length;
  for (const range of fence.content) {
    body += text.slice(end, range.from).replace(/[^\r\n]/g, '');
    body += text.slice(range.from, range.to);
    end = range.to;
  }
  body += text.slice(end, fence.close.from).replace(/[^\r\n]/g, '');
  return body.replace(/\r\n?/g, '\n');
}

function renderCode(doc, text, span) {
  const code = doc.createElement('code');
  if (span.kind === 'codeblock') {
    code.textContent = fencedText(text, span);
    const pre = doc.createElement('pre');
    pre.append(code);
    return pre;
  }
  const source = text.slice(span.from, span.to), count = /^`+/.exec(source)[0].length;
  let body = source.slice(count, -count).replace(/\r\n?|\n/g, ' ');
  if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) body = body.slice(1, -1);
  code.textContent = body;
  return code;
}

/** Render one code span or formula without rebuilding earlier wrappers. */
function replaceNext(doc, record) {
  const { element, text } = record;
  const span = record.spans[record.next++];
  const source = text.slice(span.from, span.to);
  const isCode = span.kind === 'code' || span.kind === 'codeblock';
  const rendered = isCode ? renderCode(doc, text, span) : renderFormula(doc, span.tex, Boolean(span.display));
  // Invalid TeX consumes the same work budget, but stays in the untouched tail.
  if (!isCode && rendered.dataset.valid !== 'true') return 0;
  const wrapper = doc.createElement('span');
  wrapper.className = isCode ? `lmm-chat-${span.kind}` : 'lmm-chat-formula';
  const hidden = doc.createElement('span');
  hidden.className = 'lmm-chat-source';
  hidden.textContent = source;
  hidden.setAttribute('aria-hidden', String(isCode));
  if (isCode) {
    // Keep raw fences for restoration, never as an overlaid selection surface.
    hidden.hidden = true;
    hidden.style.userSelect = 'none';
    hidden.style.pointerEvents = 'none';
    // Chromium can inherit user-select:none from a message ancestor. Explicitly
    // allow selection at every visible code level, including the pre's child.
    for (const node of [wrapper, rendered, rendered.querySelector('code')]) {
      if (!node) continue;
      node.style.userSelect = 'text';
      node.style.pointerEvents = 'auto';
    }
  } else {
    // Formula selection keeps the original TeX instead of KaTeX HTML/MathML.
    for (const node of [rendered, rendered.querySelector('.katex')]) {
      if (!node) continue;
      node.style.userSelect = 'none';
      node.style.pointerEvents = 'none';
    }
  }
  wrapper.append(hidden, rendered);
  const nodes = [];
  if (span.from > record.at) nodes.push(doc.createTextNode(text.slice(record.at, span.from)));
  nodes.push(wrapper);
  const tail = span.to < text.length ? doc.createTextNode(text.slice(span.to)) : null;
  if (tail) nodes.push(tail);
  record.tail.replaceWith(...nodes);
  record.tail = tail;
  record.at = span.to;
  record.replacements.set(wrapper, source);
  record.rendered = [...element.childNodes];
  record.texts = record.rendered.map(node => node.nodeType === 3 ? node.data : null);
  element.setAttribute(CHAT_MATH_MARK, String(record.replacements.size));
  return 1;
}

/**
 * Render complete code spans and formulas in sent user messages.
 * @returns How many code spans and formulas were rendered in this pass.
 */
export function renderChatMath(doc) {
  const state = stateFor(doc), { records } = state;
  for (const [element, record] of records) {
    if (!element.isConnected || !element.closest(USER_MESSAGE) || element.closest(SKIP) || !intact(element, record)) {
      restoreRun(element, record); records.delete(element);
    }
  }
  state.pending = state.pending.filter(record => records.get(record.element) === record);
  for (const element of candidates(doc)) {
    if (records.has(element)) continue;
    const text = element.textContent;
    const parsed = analyzeMarkdown(text);
    if (parsed.limited) continue;
    // Multi-line math stays source here exactly as it does in the composer.
    const spans = [
      ...parsed.math.filter(span => !/[\r\n\uFFFC]/.test(text.slice(span.from, span.to))),
      ...parsed.nodes.filter(node => node.name === 'InlineCode').map(node => ({ ...node, kind: 'code' })),
      ...parsed.fences.filter(fence => fence.open && fence.close).map(fence => ({
        ...fence, kind: 'codeblock',
        // A block already supplies a visual line break. Keep the source LF in
        // its wrapper instead of a following text node, or selection copies two.
        to: fence.to + (/^(?:\r\n?|\n)/.exec(text.slice(fence.to))?.[0].length ?? 0),
      })),
    ].sort((a, b) => a.from - b.from);
    if (!spans.length) continue;
    const original = [...element.childNodes];
    const record = { element, text, spans, next: 0, at: 0, tail: element.firstChild,
      original, rendered: original, texts: [text], replacements: new Map() };
    records.set(element, record); state.pending.push(record);
  }
  let applied = 0;
  // Keep the next position between passes. Each message gets one attempt before
  // another message gets a second one, including messages discovered later.
  for (let attempts = 0; attempts < MAX_RENDERS && state.pending.length; attempts++) {
    const record = state.pending.shift();
    applied += replaceNext(doc, record);
    if (record.next < record.spans.length) state.pending.push(record);
  }
  return applied;
}

/**
 * Keep sent messages rendered for the life of the plugin: scan once, then repair
 * after every repaint the conversation performs.
 */
export function createChatMath(doc, { debounce = 150 } = {}) {
  const win = doc.defaultView;
  let timer = null, observer = null, stopped = false;
  const observe = () => {
    if (!stopped && doc.body) observer?.observe(doc.body, { childList: true, subtree: true, characterData: true });
  };
  const run = () => {
    if (stopped) return 0;
    observer?.disconnect(); // our own KaTeX writes must not schedule another scan
    try {
      const applied = renderChatMath(doc);
      // Our writes are not observed. Explicitly resume the remaining work even
      // when no other conversation mutation arrives, then stop once it drains.
      if (stateFor(doc).pending.length) schedule();
      return applied;
    } catch { return 0; }   // display-only: never break the app
    finally { observe(); }
  };
  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = win.setTimeout(() => { timer = null; run(); }, debounce);
  };
  if (typeof win.MutationObserver === 'function') {
    observer = new win.MutationObserver(mutations => {
      const hasMessage = node => node.nodeType === 1 && (node.matches(USER_MESSAGE) || node.querySelector(USER_MESSAGE));
      if (mutations.some(mutation => {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        return target?.closest(USER_MESSAGE) || [...mutation.addedNodes, ...mutation.removedNodes].some(hasMessage);
      })) schedule();
    });
  }
  // Observe the resident body, not the first replaceable session flow.
  run();
  return {
    run,
    schedule,
    dispose() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      observer?.disconnect();
      observer = null;
      const state = stateFor(doc), { records } = state;
      for (const [element, record] of records) restoreRun(element, record);
      records.clear();
      state.pending.length = 0;
    },
  };
}
