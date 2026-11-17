// Runs only in a new isolated Chrome profile; never in the user's DSH page.
import React, { act } from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { readLayout, selectionRange } from '../src/native-plan.mjs';
window.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.createNativeProbe = async (factory, plugin) => {
  const api = factory(jsx, React), errors = [];
  let runtime;
  runtime = new api.DraftEditorRuntime({ openReference() {}, activeClaimToken: () => null, lexicon: () => new Map(), resolveLexicon: () => undefined, onUpdate: () => runtime.refreshProjection() });
  const editor = runtime.editor; editor._onError = error => errors.push(error.message);
  const off = runtime.register();
  const scroll = document.querySelector('[data-input-scroll]'), root = document.querySelector('#editor');
  editor.setRootElement(root); root.focus();
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const binding = { ctx: {} }, registrations = [], effects = [];
  plugin.apply({
    sessions: { binding: sessionId => sessionId === 'probe' ? binding : undefined },
    conversation: { input: { for: scope => {
      if (scope !== binding.ctx) throw new Error('Unexpected native editor scope');
      return { editor };
    } } },
    slots: {
      register(options, component) { registrations.push({ options, component }); return () => {}; },
      inject(name, callback) {
        if (name !== 'conversation.input.overlay') throw new Error(`Unexpected slot: ${name}`);
        const disposers = [...callback()]; return () => disposers.forEach(dispose => dispose());
      },
    },
    effect(callback) { effects.push(callback()); },
  });
  if (registrations.length !== 1) throw new Error('Candidate must register one native lifecycle component');
  const registration = registrations[0], props = registration.options.inject('probe');
  if (props.editor !== editor) throw new Error('Candidate did not resolve the resident editor');
  const lifecycle = document.createElement('div'); document.body.append(lifecycle);
  const pluginRoot = createRoot(lifecycle);
  await act(async () => { pluginRoot.render(React.createElement(registration.component, props)); });
  await wait();
  let unmounted = false, disposed = false;
  const unmountPlugin = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => { pluginRoot.unmount(); });
    for (const dispose of effects.reverse()) dispose();
    lifecycle.remove();
  };
  const project = () => editor.getEditorState().read(() => ({ text: runtime.projection.clipboardText, range: selectionRange(api.getSelection(), readLayout(api.getRoot())) }));
  const viewEvidence = () => ({
    html: root.innerHTML, attributes: Object.fromEntries([...root.attributes].map(attribute => [attribute.name, attribute.value])),
    selection: project().range, focused: document.activeElement === root,
    nativeStyles: [...document.querySelectorAll('style[data-plugin="dsh-live-markdown-math"]')].map(style => ({ revision: style.dataset.revision, length: style.textContent.length })),
    roles: [...root.querySelectorAll('[data-lmm-role]')].map(element => ({
      source: element.textContent, role: element.getAttribute('data-lmm-role'), hide: element.getAttribute('data-lmm-hide'),
      label: getComputedStyle(element, '::before').content, fill: getComputedStyle(element).webkitTextFillColor,
    })),
    formulas: document.querySelectorAll('.lmm-native-formula').length, errors,
  });
  const waitFor = async (predicate, description, timeout = 2500) => {
    const deadline = performance.now() + timeout;
    do {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(viewEvidence())}`);
  };
  const select = (from, to = from) => editor.update(() => {
    const layout = readLayout(api.getRoot());
    const point = at => {
      const leaf = layout.leaves.find(n => at >= n.from && at <= n.to);
      if (!leaf) throw new Error(`no leaf for ${at}`);
      return { key: leaf.key, offset: at - leaf.from };
    };
    const a = point(from), b = point(to), selection = api.getRoot().selectStart();
    selection.anchor.set(a.key, a.offset, 'text'); selection.focus.set(b.key, b.offset, 'text');
  }, { discrete: true });
  // Read the browser's caret independently of Lexical's model. Generated list
  // labels are excluded, and native paragraph gaps use the layout's offsets.
  const domRange = () => editor.getEditorState().read(() => {
    const selection = getSelection(), layout = readLayout(api.getRoot());
    if (!selection?.rangeCount) return null;
    const point = (node, offset) => {
      for (const leaf of layout.leaves) {
        const element = editor.getElementByKey(leaf.key);
        if (!element || (element !== node && !element.contains(node))) continue;
        const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, offset);
        return leaf.from + range.toString().length;
      }
      for (const [key, children] of layout.children) {
        if (editor.getElementByKey(key) !== node) continue;
        if (offset >= children.length) return layout.bounds.get(key).to;
        if (offset === node.childNodes.length) return layout.bounds.get(key).to;
        const child = children.find(key => editor.getElementByKey(key) === node.childNodes[offset]);
        return child ? layout.bounds.get(child).from : null;
      }
      return null;
    };
    return { anchor: point(selection.anchorNode, selection.anchorOffset), focus: point(selection.focusNode, selection.focusOffset) };
  });
  return window.probe = {
    api, runtime, editor, root, scroll, errors, wait, waitFor, select, project, domRange, unmountPlugin,
    // Request a normal resident editor update. Only the bundled lifecycle owns
    // the adapter; the browser fixture never mounts a source-code adapter.
    refresh() { editor.update(() => api.getRoot().markDirty(), { discrete: true }); },
    async set(text, caret) { root.focus(); runtime.setDraft(text); if (caret !== undefined) select(caret); await wait(); return project(); },
    async setLines(text, paragraphs = false) {
      root.focus();
      editor.update(() => {
        const nativeRoot = api.getRoot(); nativeRoot.clear();
        if (paragraphs) for (const line of text.split('\n')) nativeRoot.append(api.createParagraph().append(api.createText(line)));
        else { const paragraph = api.createParagraph(); nativeRoot.append(paragraph); paragraph.selectStart().insertRawText(text); }
        nativeRoot.selectEnd();
      }, { discrete: true });
      await wait(); return project();
    },
    caret() {
      const selection = getSelection();
      if (!selection?.rangeCount) return null;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { height: rect.height, width: rect.width, left: rect.left, right: rect.right, top: rect.top };
    },
    snapshot() {
      const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { ...project(), failed: root.dataset.lmmNative !== plugin.revision, errors, scrollTop: scroll.scrollTop, maxScroll: scroll.scrollHeight - scroll.clientHeight, scroll: rect(scroll), root: rect(root),
        codeblocks: [...document.querySelectorAll('.lmm-native-codeblock')].map(e => ({ rect: rect(e), clip: getComputedStyle(e).clipPath })),
        formulas: [...document.querySelectorAll('.lmm-native-formula')].map(e => ({ rect: rect(e), clip: getComputedStyle(e).clipPath, text: e.textContent })),
        placeholders: [...root.querySelectorAll('[data-lmm-math]')].map(e => ({ rect: rect(e), source: e.textContent })),
        markers: [...root.querySelectorAll('[data-lmm-hide]')].map(e => ({ rect: rect(e), source: e.textContent })),
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await unmountPlugin();
      off();
    },
  };
};
